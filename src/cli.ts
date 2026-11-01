#!/usr/bin/env node
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { missingSourceRecovery } from "./core/shutdown.js";
import { DEFAULT_TERMINAL_GEOMETRY } from "./core/terminal-input.js";
import { MAX_FILE_UPLOAD_BYTES } from "./core/uploads.js";
import { JetskiClient } from "./sdk.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    url: { type: "string" },
    id: { type: "string" },
    operation: { type: "string" },
    image: { type: "string" },
    cwd: { type: "string" },
    rows: { type: "string" },
    columns: { type: "string" },
    offset: { type: "string" },
    "state-dir": { type: "string" },
    checkpoint: { type: "string" },
    origin: { type: "string" },
  },
});
const command = positionals[0];
function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
if (command === "serve") {
  const config = JSON.parse(
    await readFile(required(values.config, "--config"), "utf8"),
  ) as {
    dataDirectory: string;
    poolId: string;
    approvedImages: string[];
    port?: number;
    hostsPerOwner?: number;
    sshGateway?: {
      hostKeyPath: string;
      host?: string;
      port: number;
      maxConnections?: number;
      principals: Array<{ owner: string; publicKey: string }>;
    };
    preview?: {
      host?: string;
      port: number;
      routes: import("./server/preview.js").PreviewRoute[];
      controlOrigins: string[];
    };
    storage?: import("./server/storage.js").StorageConfig;
    hostProvider: import("./server/hosts.js").HostConfig;
    principals: Array<{ owner: string; tokenEnv: string }>;
  };
  const [
    { SandboxManager },
    { standaloneHosts },
    { SqliteState },
    { standaloneStorage },
    { createHttpServer, bearerAuthentication, startWorker },
  ] = await Promise.all([
    import("./core/manager.js"),
    import("./server/hosts.js"),
    import("./state/sqlite.js"),
    import("./server/storage.js"),
    import("./server/http.js"),
  ]);
  const directory = resolve(config.dataDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const state = new SqliteState(join(directory, "state.sqlite"));
  const { provider, transport, streamTransport } = await standaloneHosts(
    state,
    config.hostProvider,
    config.poolId,
    config.approvedImages,
  );
  const storage = await standaloneStorage(directory, config.storage);
  const manager = new SandboxManager(
    state,
    provider,
    transport,
    storage.store,
    {
      poolId: config.poolId,
      ...(streamTransport ? { streamTransport } : {}),
      approvedImages: config.approvedImages,
      hostsPerOwner: config.hostsPerOwner ?? 1,
    },
  );
  const authenticate = bearerAuthentication(
    config.principals.map((principal) => ({
      owner: principal.owner,
      token: required(process.env[principal.tokenEnv], principal.tokenEnv),
    })),
  );
  const server = createHttpServer(manager, authenticate, {
    sshGateway: !!config.sshGateway,
    previews: !!config.preview,
    previewRoutes: config.preview?.routes ?? [],
  });
  let sshGateway:
    | ReturnType<typeof import("./server/ssh.js").createSshGateway>
    | undefined;
  if (config.sshGateway) {
    const { createSshGateway } = await import("./server/ssh.js");
    const ssh = config.sshGateway;
    sshGateway = createSshGateway(manager, {
      hostKey: await readFile(ssh.hostKeyPath),
      principals: ssh.principals,
      ...(ssh.maxConnections === undefined
        ? {}
        : { maxConnections: ssh.maxConnections }),
    });
    await new Promise<void>((resolve, reject) => {
      sshGateway!.server.once("error", reject);
      sshGateway!.server.listen(ssh.port, ssh.host ?? "127.0.0.1", resolve);
    });
  }
  let preview:
    | ReturnType<typeof import("./server/preview.js").createPreviewServer>
    | undefined;
  if (config.preview) {
    const { createPreviewServer } = await import("./server/preview.js");
    preview = createPreviewServer(manager, authenticate, {
      ...config.preview,
      sessions: manager.previewSessions,
    });
    await new Promise<void>((resolve, reject) => {
      preview!.server.once("error", reject);
      preview!.server.listen(
        config.preview!.port,
        config.preview!.host ?? "127.0.0.1",
        resolve,
      );
    });
  }
  const stopWorker = startWorker(manager, () =>
    process.stderr.write(
      "Reconciliation failed; inspect persisted operation status\n",
    ),
  );
  server.listen(config.port ?? 8788, "127.0.0.1", () =>
    process.stdout.write(
      JSON.stringify({ listening: server.address() }) + "\n",
    ),
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await preview?.close();
    await sshGateway?.close();
    await stopWorker();
    server.close(() => {
      state.close();
      storage.close();
    });
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
} else if (command === "forward") {
  const { forwardTcp } = await import("./client/forward.js");
  const config = JSON.parse(
    await readFile(required(values.config, "--config"), "utf8"),
  ) as {
    host: string;
    port: number;
    privateKeyPath: string;
    hostPublicKeyPath: string;
    localPort?: number;
    remotePort: number;
  };
  const tunnel = await forwardTcp({
    host: config.host,
    port: config.port,
    privateKey: await readFile(config.privateKeyPath),
    hostPublicKey: await readFile(config.hostPublicKeyPath, "utf8"),
    sandbox: required(positionals[1], "sandbox ID"),
    exposure: required(positionals[2], "exposure ID"),
    remotePort: config.remotePort,
    ...(config.localPort === undefined ? {} : { localPort: config.localPort }),
    onStream: (id) => {
      process.stderr.write(JSON.stringify({ streamId: id }) + "\n");
    },
  });
  process.stderr.write(
    JSON.stringify({ host: tunnel.host, port: tunnel.port }) + "\n",
  );
  const close = () => tunnel.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    await tunnel.done;
  } finally {
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
    tunnel.close();
  }
} else {
  const client = new JetskiClient(
    values.url ?? process.env.JETSKI_URL ?? "http://127.0.0.1:8788",
    required(process.env.JETSKI_TOKEN, "JETSKI_TOKEN"),
  );
  let result: unknown;
  let binaryOutput = false;
  switch (command) {
    case "preview-open":
      result = await client.createPreviewGrant(
        required(positionals[1], "sandbox ID"),
        required(positionals[2], "exposure ID"),
        required(values.origin, "--origin"),
        required(values.id, "--id"),
      );
      break;
    case "preview-status":
      result = await client.previewGrantStatus(
        required(positionals[1], "sandbox ID"),
        required(positionals[2], "grant ID"),
      );
      break;
    case "preview-revoke":
      result = await client.revokePreviewGrant(
        required(positionals[1], "sandbox ID"),
        required(positionals[2], "grant ID"),
        required(values.operation, "--operation"),
      );
      break;
    case "capabilities":
      result = await client.capabilities();
      break;
    case "stream-status":
      result = await client.streamStatus(
        required(positionals[1], "sandbox ID"),
        required(positionals[2], "stream ID"),
      );
      break;
    case "stream-cancel":
      result = await client.cancelStream(
        required(positionals[1], "sandbox ID"),
        required(positionals[2], "stream ID"),
      );
      break;
    case "checkpoints":
      result = await client.checkpoints(required(positionals[1], "sandbox ID"));
      break;
    case "checkpoint-info":
      result = await client.checkpoint(
        required(positionals[1], "sandbox ID"),
        required(positionals[2], "checkpoint ID"),
      );
      break;
    case "checkpoint-pin":
    case "checkpoint-unpin":
      result = await client.pinCheckpoint(
        required(positionals[1], "sandbox ID"),
        required(positionals[2], "checkpoint ID"),
        required(positionals[3], "pin name"),
        command === "checkpoint-pin",
        required(values.operation, "--operation"),
      );
      break;
    case "files":
      result = await client.listFiles(
        required(positionals[1], "sandbox ID"),
        required(positionals[2], "persistent path"),
      );
      break;
    case "file-read":
      binaryOutput = true;
      for await (const chunk of client.readFileStream(
        required(positionals[1], "sandbox ID"),
        required(positionals[2], "persistent path"),
      )) {
        if (!process.stdout.write(chunk)) await once(process.stdout, "drain");
      }
      break;
    case "file-write": {
      const source = required(positionals[3], "local file"),
        metadata = await stat(source);
      if (!metadata.isFile() || metadata.size > MAX_FILE_UPLOAD_BYTES)
        throw Error("Unsupported local file");
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(source)) digest.update(chunk);
      result = await client.writeFileStream(
        required(positionals[1], "sandbox ID"),
        required(values.id, "--id"),
        {
          path: required(positionals[2], "persistent path"),
          bytes: metadata.size,
          sha256: digest.digest("hex"),
          mode: metadata.mode & 0o777,
        },
        createReadStream(source),
      );
      break;
    }
    case "list":
      result = await client.request("/v1/sandboxes");
      break;
    case "get":
      result = await client.request(
        `/v1/sandboxes/${required(positionals[1], "sandbox ID")}`,
      );
      break;
    case "copy":
      result = await client.copyCheckpoint(
        required(values.id, "--id"),
        required(values.image, "--image"),
        required(values.operation, "--operation"),
        required(positionals[1], "source sandbox ID"),
        required(values.checkpoint, "--checkpoint"),
      );
      break;
    case "create":
      result = await client.request("/v1/sandboxes", "POST", {
        id: required(values.id, "--id"),
        operationId: required(values.operation, "--operation"),
        image: required(values.image, "--image"),
      });
      break;
    case "terminal-start":
      result = await client.startTerminal(
        required(positionals[1], "sandbox ID"),
        required(values.id, "--id"),
        positionals.slice(2),
        values.cwd ?? "/workspace",
        120,
        {
          rows:
            values.rows === undefined
              ? DEFAULT_TERMINAL_GEOMETRY.rows
              : Number(values.rows),
          columns:
            values.columns === undefined
              ? DEFAULT_TERMINAL_GEOMETRY.columns
              : Number(values.columns),
        },
      );
      break;
    case "terminal-attach": {
      binaryOutput = true;
      const { attachTty } = await import("./client/tty.js");
      await attachTty(
        client,
        required(positionals[1], "sandbox ID"),
        required(positionals[2], "terminal ID"),
        required(values.id, "--id"),
        required(values["state-dir"], "--state-dir"),
      );
      break;
    }
    case "terminal-follow":
      binaryOutput = true;
      for await (const chunk of client.followTerminal(
        required(positionals[1], "sandbox ID"),
        required(positionals[2], "terminal ID"),
        { offset: values.offset === undefined ? 0 : Number(values.offset) },
      )) {
        if (chunk.bytes.length && !process.stdout.write(chunk.bytes))
          await once(process.stdout, "drain");
      }
      break;
    case "terminal-status":
      result = await client.terminalStatus(
        required(positionals[1], "sandbox ID"),
        required(positionals[2], "terminal ID"),
      );
      break;
    case "terminal-close":
      result = await client.closeTerminal(
        required(positionals[1], "sandbox ID"),
        required(positionals[2], "terminal ID"),
      );
      break;
    case "terminal-input-status":
      result = await client.terminalInputStatus(
        required(positionals[1], "sandbox ID"),
        required(positionals[2], "terminal ID"),
        required(values.id, "--id"),
      );
      break;
    case "terminal-input": {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 32768) throw Error("Terminal input JSON exceeds bound");
        chunks.push(bytes);
      }
      result = await client.terminalInput(
        required(positionals[1], "sandbox ID"),
        required(positionals[2], "terminal ID"),
        required(values.id, "--id"),
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      break;
    }
    case "cancel":
      result = await client.cancelCommand(
        required(positionals[1], "sandbox ID"),
        required(positionals[2], "command ID"),
      );
      break;
    case "exec":
      result = await client.request(
        `/v1/sandboxes/${required(positionals[1], "sandbox ID")}/commands`,
        "POST",
        {
          id: required(values.id, "--id"),
          argv: positionals.slice(2),
          cwd: values.cwd ?? "/workspace",
        },
      );
      break;
    case "delete":
      result = await client.request(
        `/v1/sandboxes/${required(positionals[1], "sandbox ID")}`,
        "DELETE",
        { operationId: required(values.operation, "--operation") },
      );
      break;
    case "recover-missing-source":
      result = await client.recoverMissingSource(
        required(positionals[1], "sandbox ID"),
        required(values.operation, "--operation"),
        missingSourceRecovery(
          JSON.parse(
            await readFile(
              required(values.config, "--config recovery request JSON"),
              "utf8",
            ),
          ),
        ),
      );
      break;
    case "resume":
      result = await client.resume(
        required(positionals[1], "sandbox ID"),
        required(values.operation, "--operation"),
        values.checkpoint,
      );
      break;
    case "stop":
    case "checkpoint":
      result = await client.request(
        `/v1/sandboxes/${required(positionals[1], "sandbox ID")}/${command}`,
        "POST",
        { operationId: required(values.operation, "--operation") },
      );
      break;
    case "operation":
      result = await client.operation(
        required(positionals[1], "sandbox ID"),
        required(values.id, "--id"),
      );
      break;
    default:
      throw new Error(
        "Usage: jetski serve --config PATH | list | get ID | create --id UUID --operation UUID --image DIGEST | exec ID --id UUID -- COMMAND | operation ID --id UUID | stop ID --operation UUID | checkpoint ID --operation UUID",
      );
  }
  if (!binaryOutput)
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
