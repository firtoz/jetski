/** Disposable installed-host qualification, no operator-machine workloads. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Json } from "../src/core/contracts.js";
import type { HostLease } from "../src/core/pool.js";
import {
  encodeStreamFrame,
  STREAM_MAGIC,
  StreamDecoder,
} from "../src/core/stream-protocol.js";
import {
  type SshHost,
  SshTransport,
  sshArguments,
} from "../src/transport/ssh.js";

export async function qualifyHostStream(
  host: SshHost,
  payload: { lease: HostLease; image: string },
  request: (action: string, payload: Json) => Promise<Json>,
) {
  if (process.env.GITHUB_ACTIONS !== "true")
    throw Error("disposable_ci_required");
  const path = process.env.JETSKI_TEST_HTTP_FIXTURE;
  assert.ok(path);
  const bytes = await readFile(path),
    uploadId = randomUUID();
  await request("file-write-begin", {
    ...payload,
    uploadId,
    path: "/workspace/relay-http-fixture",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mode: 0o755,
  });
  for (let offset = 0; offset < bytes.length; offset += 262144) {
    const part = bytes.subarray(offset, offset + 262144);
    await request("file-write-chunk", {
      ...payload,
      uploadId,
      offset,
      base64: part.toString("base64"),
      sha256: createHash("sha256").update(part).digest("hex"),
    });
  }
  await request("file-write-finish", { ...payload, uploadId });
  async function wait(id: string) {
    for (let i = 0; i < 100; i++) {
      const status = (await request("command-status", {
        ...payload,
        commandId: id,
      })) as { phase: string; exitCode: number | null };
      if (
        ["succeeded", "failed", "cancelled", "uncertain"].includes(status.phase)
      )
        return status;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Error("fixture_command_deadline");
  }
  async function startServer(move: boolean) {
    const commandId = randomUUID();
    const script =
      (move
        ? "mv /workspace/relay-http-fixture /tmp/relay-http-fixture; "
        : "") +
      "rm -f /tmp/jetski-http-ready /tmp/jetski-http-complete; exec /tmp/relay-http-fixture";
    await request("command-start", {
      ...payload,
      commandId,
      argv: ["/bin/sh", "-ec", script],
      cwd: "/workspace",
      timeout: 120,
    });
    const ready = randomUUID();
    await request("command-start", {
      ...payload,
      commandId: ready,
      argv: [
        "/bin/sh",
        "-ec",
        "for i in $(seq 1 50); do test -f /tmp/jetski-http-ready && exit 0; sleep 0.1; done; exit 1",
      ],
      cwd: "/workspace",
      timeout: 10,
    });
    assert.equal((await wait(ready)).phase, "succeeded");
    return commandId;
  }
  async function stopServer(commandId: string) {
    await request("command-cancel", { ...payload, commandId });
    assert.equal((await wait(commandId)).phase, "cancelled");
  }
  const frame = (tag: "R" | "D" | "F", data = Buffer.alloc(0)) => {
    if (tag === "D")
      return Buffer.from(encodeStreamFrame({ kind: "data", bytes: data }));
    return Buffer.from(
      encodeStreamFrame({ kind: tag === "R" ? "ready" : "fin" }),
    );
  };
  async function exchange(id: string, cancel = false) {
    const header = Buffer.from(
      JSON.stringify({
        version: 1,
        id,
        action: "stream-open",
        payload: { ...payload, streamId: id, port: 18080 },
      }),
    );
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    const child = spawn("ssh", sshArguments(host), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let size = 0,
      ready = false;
    const chunks: Buffer[] = [];
    let cancellation: Promise<Json> | undefined;
    child.stdin.on("error", () => {});
    let stderr = "";
    child.stderr.on("data", (part: Buffer) => {
      stderr = (stderr + part.toString("utf8")).slice(0, 8192);
    });
    const deadline = setTimeout(() => child.kill("SIGTERM"), 30000);
    try {
      const result = new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.stdout.on("data", (part: Buffer) => {
          size += part.length;
          if (size > 1048576) {
            child.kill("SIGTERM");
            reject(Error("stream_output_bound"));
            return;
          }
          chunks.push(part);
          if (cancel && !ready && size >= 5) {
            ready = true;
            if (!Buffer.concat(chunks).subarray(0, 5).equals(frame("R"))) {
              child.kill("SIGTERM");
              reject(Error("Invalid relay ready frame"));
              return;
            }
            cancellation = request("stream-cancel", {
              ...payload,
              streamId: id,
            });
            cancellation.catch(reject);
          }
        });
        child.on("close", resolve);
      });
      child.stdin.write(
        Buffer.concat([Buffer.from(STREAM_MAGIC), length, header]),
      );
      if (!cancel)
        child.stdin.end(
          Buffer.concat([
            frame(
              "D",
              Buffer.from("GET / HTTP/1.0\r\nHost: localhost\r\n\r\n"),
            ),
            frame("F"),
          ]),
        );
      const code = await result;
      if (cancellation) await cancellation;
      return { code, bytes: Buffer.concat(chunks), stderr };
    } finally {
      clearTimeout(deadline);
      child.stdin.destroy();
      if (child.exitCode === null) child.kill("SIGTERM");
    }
  }
  const server = await startServer(true),
    id = randomUUID();
  const response = await exchange(id);
  assert.equal(response.code, 0, response.stderr);
  assert.deepEqual(response.bytes.subarray(0, 5), frame("R"));
  const content: Uint8Array[] = [];
  const decoder = new StreamDecoder(true);
  for (const part of decoder.feed(response.bytes)) {
    if (part.kind === "data") content.push(part.bytes);
  }
  decoder.finish();
  assert.ok(Buffer.concat(content).toString().endsWith("relay-container"));
  const receipt = (await request("stream-status", {
    ...payload,
    streamId: id,
  })) as { phase: string; delivery: string };
  assert.equal(receipt.phase, "closed");
  assert.equal(receipt.delivery, "complete");
  assert.notEqual((await exchange(id)).code, 0);
  assert.deepEqual(
    await request("stream-status", { ...payload, streamId: id }),
    receipt,
  );
  await stopServer(server);
  const next = await startServer(false),
    cancelled = randomUUID();
  assert.notEqual((await exchange(cancelled, true)).code, 0);
  assert.equal(
    (
      (await request("stream-status", { ...payload, streamId: cancelled })) as {
        phase: string;
      }
    ).phase,
    "uncertain",
  );
  // Cancellation closes the accepted socket before a request is sent.
  // The strict fixture must independently finish with its invalid-request exit.
  const interruptedServer = await wait(next);
  assert.equal(interruptedServer.phase, "failed");
  assert.equal(interruptedServer.exitCode, 1);
  const adapterServer = await startServer(false);
  const transport = new SshTransport([host]);
  const adapterId = randomUUID();
  const connection = await transport.open(host.id, {
    ...payload,
    streamId: adapterId,
    port: 18080,
  });
  await connection.send(
    Buffer.from("GET / HTTP/1.0\r\nHost: localhost\r\n\r\n"),
  );
  await connection.end();
  const adapterBytes: Uint8Array[] = [];
  for await (const part of connection.output) adapterBytes.push(part);
  await connection.completed;
  assert.ok(Buffer.concat(adapterBytes).toString().endsWith("relay-container"));
  assert.equal(
    (
      (await request("stream-status", { ...payload, streamId: adapterId })) as {
        phase: string;
      }
    ).phase,
    "closed",
  );
  await assert.rejects(
    transport.open(host.id, { ...payload, streamId: adapterId, port: 18080 }),
  );
  await stopServer(adapterServer);
}
