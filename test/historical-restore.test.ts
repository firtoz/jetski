import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { CheckpointRegistry } from "../src/core/checkpoints.js";
import { SandboxManager } from "../src/core/manager.js";
import { OperationJournal } from "../src/core/operations.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

const sha = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
test("selected restore references survive fencing and cannot be removed with user pins", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-history-restore-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const store = new LocalCheckpointStore(join(directory, "objects"));
  const registry = new CheckpointRegistry(state, store),
    operations = new OperationJournal(state);
  const scope = { owner: "owner", sandbox: randomUUID() },
    fence = await operations.generation(scope);
  await registry.initialize(fence);
  const data = gzipSync(Buffer.alloc(2048));
  const info = { ...scope, id: "frame", bytes: data.length, sha256: sha(data) };
  await store.put(
    info,
    (async function* () {
      yield data;
    })(),
    info,
  );
  const archive = {
    version: 1,
    bytes: data.length,
    sha256: sha(data),
    expandedBytes: 2048,
    entries: 2,
    frames: [
      {
        bytes: data.length,
        offset: 0,
        sha256: sha(data),
        expandedBytes: 2048,
        expandedSha256: sha(Buffer.alloc(2048)),
      },
    ],
  };
  for (const id of ["old", "latest", "output"]) {
    await registry.admit(fence, id, "writer");
    await registry.publish(
      fence,
      id,
      id,
      [info],
      id === "output" ? { kind: "command-output" } : archive,
    );
  }
  const image = "example/linux@sha256:" + "a".repeat(64);
  await state.transaction((tx) =>
    tx.put(`sandbox/${scope.owner}/${scope.sandbox}`, {
      id: scope.sandbox,
      owner: scope.owner,
      image,
      createOperation: randomUUID(),
      placementOperation: randomUUID(),
      restoreCheckpoint: null,
      pendingResume: null,
      phase: "stopped",
      lease: null,
      checkpoint: "latest",
      generation: 1,
    }),
  );
  const manager = new SandboxManager(
    state,
    {
      capabilities: () => ({
        kind: "machine-host",
        architecture: "x86_64",
        rootlessPodman: true,
      }),
      allocate: async () => {
        throw Error("must not allocate");
      },
      inspect: async () => ({ state: "absent" }),
      retire: async () => {},
    },
    {
      request: async () => {
        throw Error("must not contact host");
      },
    },
    store,
    { poolId: "pool", approvedImages: [image] },
  );
  await assert.rejects(
    manager.resume(scope, randomUUID(), "missing"),
    /unavailable/,
  );
  await assert.rejects(
    manager.resume(scope, randomUUID(), "output"),
    /archive/,
  );
  assert.equal((await manager.get(scope))?.generation, 1);
  const id = randomUUID();
  const queued = await manager.resume(scope, id, "old");
  assert.equal(queued?.restoreCheckpoint, "old");
  assert.equal(queued?.checkpoint, "latest");
  assert.equal(queued?.generation, 2);
  const next = { ...scope, generation: 2 };
  await registry.pin(next, "old", id, false);
  await assert.rejects(registry.retire(next, "old"), /protected/);
  await assert.rejects(registry.collect(next, "gc"), /references/);
  await assert.rejects(
    manager.resume(scope, id, "latest"),
    /identity conflict/,
  );
  assert.equal((await manager.resume(scope, id, "old"))?.generation, 2);
  await manager.deleteSandbox(scope, randomUUID());
  assert.equal((await operations.get(scope, id))?.phase, "failed");
  await registry.retire(next, "old");
  assert.ok(await registry.root(next, "latest"));
  assert.equal(
    (
      await state.transaction((tx) =>
        tx.scan(`checkpoint-reference/${scope.owner}/${scope.sandbox}/`),
      )
    ).length,
    0,
  );
});
