import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CheckpointRegistry,
  DEFAULTS,
  type Transaction,
} from "../src/core/index.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

test("publication verifies bytes; retained roots and readers exclude collection", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jetski-gc-"));
  const state = new SqliteState(join(dir, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(dir, { recursive: true, force: true });
  });
  const objects = new LocalCheckpointStore(join(dir, "objects"));
  let now = 1_000_000;
  const registry = new CheckpointRegistry(state, objects, () => now);
  const fence = { owner: "alice", sandbox: "box", generation: 1 };
  await registry.initialize(fence);
  const bytes = Buffer.from("binary\x00\xff fixture");
  const frame = {
    ...fence,
    id: "frame",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  await registry.admit(fence, "write1", "writer");
  await assert.rejects(
    registry.publish(fence, "write1", "root1", [frame]),
    /integrity/,
  );
  await objects.put(
    frame,
    (async function* () {
      yield bytes;
    })(),
    frame,
  );
  await registry.publish(fence, "write1", "root1", [frame]);
  await assert.rejects(
    registry.admit(fence, "write1", "writer"),
    /already exists/,
  );
  await registry.admit(fence, "read1", "reader", "root1");
  await assert.rejects(registry.collect(fence, "collection1"), /Active/);
  await assert.rejects(registry.retire(fence, "root1"), /protected/);
  await registry.close(fence, "read1");
  await registry.pin(fence, "root1", "keep", true);
  await assert.rejects(registry.retire(fence, "root1"), /protected/);
  await registry.pin(fence, "root1", "keep", false);
  await registry.retire(fence, "root1");
  assert.deepEqual(await registry.collect(fence, "early"), { deleted: 0 });
  now += DEFAULTS.gcGraceMs;
  assert.deepEqual(await registry.collect(fence, "due"), { deleted: 1 });
  assert.equal(await objects.head(frame), undefined);
});

test("corrupt retained roots fail closed before deleting any eligible frame", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jetski-gc-"));
  const state = new SqliteState(join(dir, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(dir, { recursive: true, force: true });
  });
  const objects = new LocalCheckpointStore(join(dir, "objects"));
  let now = 1;
  const registry = new CheckpointRegistry(state, objects, () => now);
  const fence = { owner: "owner", sandbox: "box", generation: 1 };
  await registry.initialize(fence);
  for (const id of ["old", "retained"]) {
    const bytes = Buffer.from(id);
    const info = {
      ...fence,
      id,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    await objects.put(
      info,
      (async function* () {
        yield bytes;
      })(),
      info,
    );
    await registry.admit(fence, id, "writer");
    await registry.publish(fence, id, id, [info]);
  }
  await registry.retire(fence, "old");
  now += DEFAULTS.gcGraceMs;
  await writeFile(
    join(dir, "objects", "owner", "box", "retained.blob"),
    "corrupt",
  );
  await assert.rejects(registry.collect(fence, "sweep"), /integrity/);
  assert.ok(await objects.head({ ...fence, id: "old" }));
  await assert.rejects(registry.admit(fence, "new", "writer"), /Collection/);
  await assert.rejects(registry.collect(fence, "different"), /Different/);
  const restarted = new CheckpointRegistry(state, objects, () => now);
  await assert.rejects(restarted.collect(fence, "sweep"), /integrity/);
});

test("transaction handles cannot be used after commit or from an async callback", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jetski-tx-"));
  const state = new SqliteState(join(dir, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(dir, { recursive: true, force: true });
  });
  const escaped = await state.transaction((tx) => tx);
  assert.throws(() => escaped.put("outside", 1), /expired/);
  let deferred: Transaction | undefined;
  await assert.rejects(
    state.transaction((tx) => {
      deferred = tx;
      return Promise.resolve(1);
    }),
    /synchronous/,
  );
  assert.throws(() => deferred?.put("outside", 1), /expired/);
});
