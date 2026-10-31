#!/usr/bin/env node
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
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
    sshHosts: import("./transport/ssh.js").SshHost[];
    principals: Array<{ owner: string; tokenEnv: string }>;
  };
  const [
    { SandboxManager },
    { SshHostProvider },
    { SshTransport },
    { SqliteState },
    { LocalCheckpointStore },
    { createHttpServer, bearerAuthentication, startWorker },
  ] = await Promise.all([
    import("./core/manager.js"),
    import("./providers/ssh.js"),
    import("./transport/ssh.js"),
    import("./state/sqlite.js"),
    import("./storage/local.js"),
    import("./server/http.js"),
  ]);
  const directory = resolve(config.dataDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const state = new SqliteState(join(directory, "state.sqlite"));
  const transport = new SshTransport(config.sshHosts);
  const provider = new SshHostProvider(
    config.sshHosts.map((host) => host.id),
    state,
    transport,
  );
  const manager = new SandboxManager(
    state,
    provider,
    transport,
    new LocalCheckpointStore(join(directory, "objects")),
    {
      poolId: config.poolId,
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
  const server = createHttpServer(manager, authenticate);
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
    await stopWorker();
    server.close(() => state.close());
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
} else {
  const client = new JetskiClient(
    values.url ?? process.env.JETSKI_URL ?? "http://127.0.0.1:8788",
    required(process.env.JETSKI_TOKEN, "JETSKI_TOKEN"),
  );
  let result: unknown;
  let binaryOutput = false;
  switch (command) {
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
    case "create":
      result = await client.request("/v1/sandboxes", "POST", {
        id: required(values.id, "--id"),
        operationId: required(values.operation, "--operation"),
        image: required(values.image, "--image"),
      });
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
    case "resume":
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
