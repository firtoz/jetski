import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { CheckpointHistory } from "../src/core/checkpoint-history.js";
import { CheckpointRegistry } from "../src/core/checkpoints.js";
import { OperationJournal } from "../src/core/operations.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

const sha = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
test("checkpoint history pages and pins are owner scoped, atomic and replay safe", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jetski-history-"));
  const state = new SqliteState(join(dir, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(dir, { recursive: true, force: true });
  });
  const objects = new LocalCheckpointStore(join(dir, "objects"));
  const registry = new CheckpointRegistry(state, objects),
    operations = new OperationJournal(state);
  const scope = { owner: "alice", sandbox: "box" },
    fence = await operations.generation(scope);
  await registry.initialize(fence);
  await state.transaction((tx) =>
    tx.put("sandbox/alice/box", {
      generation: 1,
      phase: "stopped",
      checkpoint: "a",
    }),
  );
  const data = gzipSync(Buffer.alloc(2048));
  const frame = {
    ...scope,
    id: "object",
    bytes: data.length,
    sha256: sha(data),
  };
  await objects.put(
    frame,
    (async function* () {
      yield data;
    })(),
    frame,
  );
  const metadata = {
    version: 1,
    sha256: sha(data),
    bytes: data.length,
    expandedBytes: 2048,
    entries: 2,
    frames: [
      {
        offset: 0,
        bytes: data.length,
        expandedBytes: 2048,
        sha256: sha(data),
        expandedSha256: sha(Buffer.alloc(2048)),
      },
    ],
  };
  for (const id of ["a", "b", "c", "output"]) {
    await registry.admit(fence, `write-${id}`, "writer");
    await registry.publish(
      fence,
      `write-${id}`,
      id,
      [frame],
      id === "output"
        ? {
            kind: "command-output",
            version: 1,
            commandId: "00000000-0000-0000-0000-000000000001",
            status: {
              id: "00000000-0000-0000-0000-000000000001",
              phase: "succeeded",
            },
            channels: { stdout: [0], stderr: [] },
          }
        : metadata,
    );
  }
  const history = new CheckpointHistory(state, registry, operations);
  const first = await history.list(scope, "", 2);
  assert.deepEqual(
    first.checkpoints.map((root) => root.id),
    ["a", "b"],
  );
  assert.equal(first.next, "b");
  assert.deepEqual(
    (await history.list(scope, first.next!, 2)).checkpoints.map(
      (root) => root.id,
    ),
    ["c"],
  );
  assert.equal(await history.get(scope, "output"), undefined);
  await assert.rejects(
    history.list({ ...scope, owner: "foreign" }),
    /unavailable/,
  );
  await assert.rejects(
    history.pin(scope, "output", "keep", true, "bad"),
    /Filesystem/,
  );
  assert.equal(await operations.get(scope, "bad"), undefined);
  const pinned = await history.pin(scope, "a", "keep", true, "pin1");
  assert.equal(pinned.phase, "succeeded");
  await assert.rejects(registry.retire(fence, "a"), /protected/);
  await history.pin(scope, "a", "keep", false, "unpin1");
  assert.deepEqual(await history.pin(scope, "a", "keep", true, "pin1"), pinned);
  assert.deepEqual((await history.get(scope, "a"))?.pins, []);
  await assert.rejects(
    history.pin(scope, "a", "keep", false, "pin1"),
    /identity conflict/,
  );
  const original = registry.pinIn.bind(registry);
  registry.pinIn = (...args) => {
    original(...args);
    throw Error("after mutation");
  };
  await assert.rejects(
    history.pin(scope, "a", "rollback", true, "pin2"),
    /after mutation/,
  );
  assert.deepEqual((await history.get(scope, "a"))?.pins, []);
  assert.equal(await operations.get(scope, "pin2"), undefined);
  registry.pinIn = original;
  await history.pin(scope, "a", "rollback", true, "pin2");
  await state.transaction((tx) => {
    registry.advanceIn(tx, fence);
    operations.advanceIn(tx, fence);
    tx.put("sandbox/alice/box", {
      generation: 2,
      phase: "deleted",
      checkpoint: "a",
    });
  });
  assert.deepEqual(await history.pin(scope, "a", "keep", true, "pin1"), pinned);
  assert.deepEqual((await history.get(scope, "a"))?.pins, ["rollback"]);
  assert.equal((await history.list(scope)).checkpoints.length, 3);
});
