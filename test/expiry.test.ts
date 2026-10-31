import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { CheckpointRegistry } from "../src/core/checkpoints.js";
import {
  DEFAULTS,
  type HostProvider,
  type Json,
} from "../src/core/contracts.js";
import { SandboxManager } from "../src/core/manager.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

const image = "example/linux@sha256:" + "a".repeat(64);
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
test("expiry drain preserves source through failed publication past deadline and resumes after restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-expiry-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const objects = new LocalCheckpointStore(join(directory, "objects"));
  let now = 1,
    retirements = 0,
    failRead = true;
  const provider: HostProvider = {
    capabilities: () => ({
      kind: "machine-host",
      architecture: "x86_64",
      rootlessPodman: true,
    }),
    allocate: async (input) => ({
      id: "host",
      allocationId: input.operationId,
    }),
    inspect: async () => ({ state: "ready" }),
    retire: async () => {
      retirements++;
    },
  };
  const data = Buffer.from("expiry fixture"),
    bytes = gzipSync(data);
  const archive = {
    version: 1,
    sha256: sha(bytes),
    bytes: bytes.length,
    expandedBytes: data.length,
    entries: 2,
    frames: [
      {
        offset: 0,
        bytes: bytes.length,
        sha256: sha(bytes),
        expandedBytes: data.length,
        expandedSha256: sha(data),
      },
    ],
  };
  const actions: string[] = [];
  const transport = {
    request: async (
      _host: string,
      request: { id: string; action: string; payload: Json },
    ) => {
      actions.push(request.action);
      let result: Json = null;
      if (request.action === "capture") result = archive;
      if (request.action === "read-checkpoint") {
        if (failRead) throw Error("source temporarily unreachable");
        const input = request.payload as { offset: number; bytes: number };
        result = {
          ...input,
          base64: bytes
            .subarray(input.offset, input.offset + input.bytes)
            .toString("base64"),
        };
      }
      return { version: 1 as const, id: request.id, result };
    },
  };
  const options = { poolId: "pool", approvedImages: [image], now: () => now };
  let manager = new SandboxManager(
    state,
    provider,
    transport,
    objects,
    options,
  );
  const scope = { owner: "alice", sandbox: randomUUID() };
  await manager.create("alice", scope.sandbox, image, randomUUID());
  await manager.reconcile("alice");
  now += DEFAULTS.hostLifetimeMs - DEFAULTS.hostDrainMs - 1;
  await manager.reconcile("alice");
  assert.equal((await manager.get(scope))?.phase, "running");
  now++;
  await assert.rejects(manager.reconcile("alice"), /temporarily unreachable/);
  assert.equal((await manager.get(scope))?.phase, "quarantined");
  assert.ok((await manager.get(scope))?.lease);
  assert.equal(actions.includes("release"), false);
  assert.equal(retirements, 0);
  now += DEFAULTS.hostDrainMs + 1;
  await assert.rejects(manager.reconcile("alice"), /temporarily unreachable/);
  assert.equal(actions.includes("remove"), false);
  assert.equal(retirements, 0, "deadline is never proof of publication");
  failRead = false;
  manager = new SandboxManager(state, provider, transport, objects, options);
  await manager.reconcile("alice");
  const stopped = await manager.get(scope);
  assert.equal(stopped?.phase, "stopped");
  assert.equal(stopped.lease, null);
  assert.equal(retirements, 1);
  const drains = await state.transaction((tx) =>
    tx.scan<{ operationId: string }>("expiry-drain/"),
  );
  assert.equal(drains.length, 1);
  assert.equal(
    (await manager.operation(scope, drains[0]!.value.operationId))?.phase,
    "succeeded",
  );
  const root = await new CheckpointRegistry(state, objects).root(
    { ...scope, generation: 1 },
    stopped.checkpoint!,
  );
  assert.ok(root);
  const restored: Uint8Array[] = [];
  for (const frame of root.frames)
    for await (const chunk of objects.read(frame)) restored.push(chunk);
  assert.deepEqual(Buffer.concat(restored), bytes);
  await manager.reconcile("alice");
  assert.equal(retirements, 1);
});
