import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { resumeCachedCheckpoint } from "../src/core/cached-resume.js";
import { CheckpointRegistry } from "../src/core/checkpoints.js";
import type { Json } from "../src/core/contracts.js";
import { CheckpointTransfer } from "../src/core/transfer.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
test("cached resume retains a reader and rejects ambiguous or stale readiness", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-cached-resume-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const store = new LocalCheckpointStore(join(directory, "objects"));
  const registry = new CheckpointRegistry(state, store);
  const fence = { owner: "owner", sandbox: "sandbox", generation: 1 };
  const lease = {
    owner: fence.owner,
    sandboxId: fence.sandbox,
    machineId: "host",
    poolId: "pool",
    slotId: randomUUID(),
    assignmentId: randomUUID(),
    generation: 2,
  };
  const image = "example/linux@sha256:" + "a".repeat(64),
    resources = { cpus: 2, memoryMb: 2048 };
  await registry.initialize(fence);
  const raw = Buffer.alloc(1024),
    bytes = gzipSync(raw),
    id = randomUUID();
  const archive = {
    version: 1,
    sha256: sha(bytes),
    bytes: bytes.length,
    expandedBytes: raw.length,
    entries: 2,
    frames: [
      {
        offset: 0,
        bytes: bytes.length,
        sha256: sha(bytes),
        expandedBytes: raw.length,
        expandedSha256: sha(raw),
      },
    ],
  };
  await new CheckpointTransfer(store, registry).save(fence, id, archive, {
    read: async (offset, count) => bytes.subarray(offset, offset + count),
  });
  const ready = {
    lease,
    checkpointId: id,
    sha256: archive.sha256,
    bytes: archive.bytes,
    ready: true,
    runtime: {
      name: "jetski-" + lease.assignmentId,
      phase: "running",
      image,
      configuration: { ...resources, image },
    },
  };
  const unexpected = async () => {
    throw Error("No ordinary transport request expected");
  };
  let called = 0;
  const invoke = async (
    response: Json | Error,
    selectedFence = fence,
    selectedId: string = id,
    selectedLease = lease,
  ) =>
    resumeCachedCheckpoint(
      registry,
      selectedFence,
      selectedLease,
      image,
      resources,
      selectedId,
      {
        request: unexpected,
        resumeCached: async (host, input) => {
          called++;
          assert.equal(host, lease.machineId);
          assert.equal(input.checkpointId, id);
          const held = await state.transaction((tx) =>
            tx.get<{ accesses: { kind: string; root: string | null }[] }>(
              `checkpoint/${fence.owner}/${fence.sandbox}`,
            ),
          );
          assert.ok(
            held?.accesses.some(
              (access) => access.kind === "reader" && access.root === id,
            ),
          );
          if (response instanceof Error) throw response;
          return response;
        },
      },
    );
  assert.equal(await invoke(ready), true);
  assert.equal(await invoke({ ...ready, ready: false, runtime: null }), false);
  for (const invalid of [
    { ...ready, sha256: "b".repeat(64) },
    { ...ready, lease: { ...lease, generation: 3 } },
    {
      ...ready,
      runtime: { ...ready.runtime, configuration: { cpus: 1, memoryMb: 2048 } },
    },
    { ...ready, ready: false },
  ])
    await assert.rejects(invoke(invalid));
  await assert.rejects(invoke(Error("ACK lost")), /ACK lost/);
  const before = called;
  await assert.rejects(invoke(ready, { ...fence, generation: 2 }));
  await assert.rejects(invoke(ready, fence, "unretained"));
  assert.equal(
    await invoke(ready, fence, id, { ...lease, generation: 1 }),
    false,
  );
  assert.equal(called, before);
  const record = await state.transaction((tx) =>
    tx.get<{ accesses: Json[] }>(`checkpoint/${fence.owner}/${fence.sandbox}`),
  );
  assert.deepEqual(record?.accesses, []);
  assert.ok(
    await registry.root(fence, id),
    "failed optimizations must retain acknowledged roots",
  );
});
