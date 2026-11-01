import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { CheckpointRegistry } from "../src/core/checkpoints.js";
import type { HostProvider, Json } from "../src/core/contracts.js";
import { type Sandbox, SandboxManager } from "../src/core/manager.js";
import type { HostTransport } from "../src/core/transport.js";
import { JetskiClient } from "../src/sdk.js";
import { bearerAuthentication, createHttpServer } from "../src/server/http.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

const image = `example/linux@sha256:${"a".repeat(64)}`;
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

test("checkpoint-backed sandbox admission, restart, cancellation and explicit restore", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-sandbox-copy-"));
  const path = join(directory, "state.sqlite");
  let state = new SqliteState(path);
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const objects = new LocalCheckpointStore(join(directory, "objects"));
  let allocations = 0;
  const provider: HostProvider = {
    capabilities: () => ({
      kind: "machine-host",
      architecture: "x86_64",
      rootlessPodman: true,
    }),
    allocate: async (input) => {
      allocations++;
      return { id: "host", allocationId: input.operationId };
    },
    inspect: async () => ({ state: "ready" }),
    retire: async () => {},
  };
  const received: Buffer[] = [];
  let imported: Record<string, Json> = {};
  const transport: HostTransport = {
    request: async (_host, request) => {
      const payload = request.payload as Record<string, Json>;
      let result: Json = {};
      if (request.action === "import-begin") {
        imported = {
          id: payload.checkpointId!,
          sha256: payload.sha256!,
          bytes: payload.bytes!,
          offset: 0,
          phase: "receiving",
        };
        result = imported;
      } else if (request.action === "import-chunk") {
        const bytes = Buffer.from(String(payload.base64), "base64");
        assert.equal(
          payload.offset,
          received.reduce((n, b) => n + b.length, 0),
        );
        received.push(bytes);
        imported = {
          ...imported,
          offset: Number(imported.offset) + bytes.length,
        };
        result = imported;
      } else if (request.action === "import-finish")
        result = { ...imported, phase: "ready" };
      return { version: 1, id: request.id, result };
    },
  };
  const manager = () =>
    new SandboxManager(state, provider, transport, objects, {
      poolId: "pool",
      approvedImages: [image],
    });
  const registry = () => new CheckpointRegistry(state, objects);
  const token = "a".repeat(32);
  const server = createHttpServer(
    manager(),
    bearerAuthentication([
      { owner: "alice", token },
      { owner: "bob", token: "b".repeat(32) },
    ]),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const client = new JetskiClient(url, token);
  assert.equal((await client.capabilities()).checkpointCopy, true);

  const source = { owner: "alice", sandbox: randomUUID(), generation: 1 };
  const checkpointId = randomUUID();
  const sourceRecord: Sandbox = {
    id: source.sandbox,
    owner: source.owner,
    image,
    createOperation: randomUUID(),
    placementOperation: randomUUID(),
    restoreCheckpoint: null,
    pendingResume: null,
    phase: "stopped",
    lease: null,
    checkpoint: checkpointId,
    generation: 1,
  };
  await state.transaction((tx) =>
    tx.put(`sandbox/alice/${source.sandbox}`, sourceRecord),
  );
  await registry().initialize(source);
  await registry().admit(source, "writer", "writer");
  const plain = [
    Buffer.from("binary\0\xff"),
    Buffer.from("Unicode λ"),
    Buffer.from("prepared dependency bytes"),
  ];
  const compressed = plain.map((b) => gzipSync(b));
  let offset = 0;
  const metadata = {
    version: 1,
    sha256: sha(Buffer.concat(compressed)),
    bytes: Buffer.concat(compressed).length,
    expandedBytes: Buffer.concat(plain).length,
    entries: 3,
    frames: compressed.map((b, i) => {
      const frame = {
        offset,
        bytes: b.length,
        expandedBytes: plain[i]!.length,
        sha256: sha(b),
        expandedSha256: sha(plain[i]!),
      };
      offset += b.length;
      return frame;
    }),
  };
  const frames = [];
  for (const bytes of compressed)
    frames.push(
      await objects.put(
        { ...source, id: randomUUID() },
        (async function* () {
          yield bytes;
        })(),
        { bytes: bytes.length, sha256: sha(bytes) },
      ),
    );
  await registry().publish(source, "writer", checkpointId, frames, metadata);
  await registry().close(source, "writer");
  const id = randomUUID(),
    operation = randomUUID(),
    scope = { owner: "alice", sandbox: id };
  assert.equal(
    (
      await client.copyCheckpoint(
        id,
        image,
        operation,
        source.sandbox,
        checkpointId,
      )
    ).phase,
    "copying",
  );
  await assert.rejects(
    manager().copyCheckpoint(
      "alice",
      id,
      image,
      operation,
      source.sandbox,
      "different",
    ),
    /identity conflict/,
  );
  await assert.rejects(
    manager().copyCheckpoint(
      "bob",
      randomUUID(),
      image,
      randomUUID(),
      source.sandbox,
      checkpointId,
    ),
    /unavailable/,
  );
  const outsider = new JetskiClient(url, "b".repeat(32));
  await assert.rejects(
    outsider.copyCheckpoint(
      randomUUID(),
      image,
      randomUUID(),
      source.sandbox,
      checkpointId,
    ),
    /400/,
  );
  const incomplete = await fetch(`${url}/v1/sandboxes`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      id: randomUUID(),
      image,
      operationId: randomUUID(),
      sourceSandbox: source.sandbox,
    }),
  });
  assert.equal(incomplete.status, 400);
  await manager().reconcile("alice");
  assert.equal((await manager().get(scope))?.phase, "copying");
  assert.equal(allocations, 0);
  await assert.rejects(registry().retire(source, checkpointId), /protected/);
  state.close();
  state = new SqliteState(path);
  await manager().reconcile("alice");
  assert.equal((await manager().get(scope))?.phase, "stopped");
  assert.equal(
    (await manager().operation(scope, operation))?.phase,
    "succeeded",
  );
  assert.equal(allocations, 0, "copying and publication never allocate a host");
  assert.equal(
    (
      await manager().copyCheckpoint(
        "alice",
        id,
        image,
        operation,
        source.sandbox,
        checkpointId,
      )
    ).phase,
    "stopped",
  );

  const cancelled = randomUUID(),
    cancelCopy = randomUUID(),
    deletion = randomUUID();
  const cancelScope = { owner: "alice", sandbox: cancelled };
  await manager().copyCheckpoint(
    "alice",
    cancelled,
    image,
    cancelCopy,
    source.sandbox,
    checkpointId,
  );
  await manager().reconcile("alice");
  await manager().deleteSandbox(cancelScope, deletion);
  state.close();
  state = new SqliteState(path);
  await manager().reconcile("alice");
  assert.equal((await manager().get(cancelScope))?.phase, "deleted");
  assert.equal(
    (await manager().operation(cancelScope, deletion))?.phase,
    "succeeded",
  );
  assert.equal(
    (await manager().operation(cancelScope, cancelCopy))?.phase,
    "failed",
  );
  await manager().deleteSandbox(cancelScope, deletion);
  assert.equal(
    (
      await manager().copyCheckpoint(
        "alice",
        cancelled,
        image,
        cancelCopy,
        source.sandbox,
        checkpointId,
      )
    ).phase,
    "deleted",
  );
  assert.equal(allocations, 0);

  await registry().retire(source, checkpointId);
  for (const frame of frames) await objects.delete(frame);
  await manager().resume(scope, randomUUID());
  await manager().reconcile("alice");
  assert.equal((await manager().get(scope))?.phase, "running");
  assert.equal(allocations, 1);
  assert.deepEqual(
    Buffer.concat(received),
    Buffer.concat(compressed),
    "target restore reads its independent exact bytes after source deletion",
  );
});
