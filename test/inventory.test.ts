import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CheckpointRegistry } from "../src/core/checkpoints.js";
import { DEFAULTS, type ObjectInfo } from "../src/core/contracts.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

test("orphan grace, complete inventory and lost deletion ACK survive reopen", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-inventory-"));
  let state = new SqliteState(join(directory, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const store = new LocalCheckpointStore(join(directory, "objects"));
  const fence = { owner: "owner", sandbox: "box", generation: 1 };
  let now = 1000;
  let registry = new CheckpointRegistry(state, store, () => now);
  await registry.initialize(fence);
  const frames: ObjectInfo[] = [];
  for (let index = 0; index < 66; index++) {
    const bytes = Buffer.from(`binary\0${index}`);
    frames.push(
      await store.put(
        { ...fence, id: `object_${String(index).padStart(3, "0")}` },
        (async function* () {
          yield bytes;
        })(),
        {
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ),
    );
  }
  assert.deepEqual(await registry.collect(fence, "mark"), { deleted: 0 });
  const receipt = (await state.transaction((tx) =>
    tx.get("checkpoint-inventory/owner/box/mark"),
  )) as { complete: boolean; pages: number; objects: number };
  assert.equal(receipt.complete, true);
  assert.equal(receipt.pages, 2);
  assert.equal(receipt.objects, 66);
  // An observed orphan may become retained before the next collection.
  await registry.admit(fence, "adopt", "writer");
  await registry.publish(fence, "adopt", "retained", [frames[0]!]);
  now += DEFAULTS.gcGraceMs - 1;
  assert.deepEqual(await registry.collect(fence, "early"), { deleted: 0 });
  now++;
  const originalList = store.list.bind(store);
  store.list = async function* (scope) {
    let count = 0;
    for await (const frame of originalList(scope)) {
      yield frame;
      if (++count === 64) throw Error("listing interrupted");
    }
  };
  const originalDelete = store.delete.bind(store);
  const deletions: string[] = [];
  let lose = true;
  store.delete = async (address) => {
    deletions.push(address.id);
    await originalDelete(address);
    if (lose) {
      lose = false;
      throw Error("delete acknowledgement lost");
    }
  };
  await assert.rejects(registry.collect(fence, "sweep"), /listing interrupted/);
  assert.deepEqual(deletions, []);
  const incomplete = (await state.transaction((tx) =>
    tx.get("checkpoint-inventory/owner/box/sweep"),
  )) as { complete: boolean; pages: number };
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.pages, 1);
  await assert.rejects(
    registry.admit(fence, "blocked", "writer"),
    /Collection/,
  );
  store.list = originalList;
  await assert.rejects(
    registry.collect(fence, "sweep"),
    /acknowledgement lost/,
  );
  state.close();
  state = new SqliteState(join(directory, "state.sqlite"));
  registry = new CheckpointRegistry(state, store, () => now);
  assert.deepEqual(await registry.collect(fence, "sweep"), { deleted: 65 });
  assert.equal(deletions.length, 66);
  assert.equal(deletions[0], deletions[1]);
  assert.ok(await store.head(frames[0]!));
  for (const frame of frames.slice(1))
    assert.equal(await store.head(frame), undefined);
  assert.deepEqual(await registry.collect(fence, "sweep"), { deleted: 65 });
  assert.equal(deletions.length, 66);
});

test("foreign and duplicate inventory entries fail closed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-inventory-invalid-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const store = new LocalCheckpointStore(join(directory, "objects"));
  const fence = { owner: "owner", sandbox: "box", generation: 1 };
  const registry = new CheckpointRegistry(state, store);
  await registry.initialize(fence);
  let deletions = 0;
  store.delete = async () => {
    deletions++;
  };
  const frame = {
    owner: "owner",
    sandbox: "box",
    id: "object",
    bytes: 1,
    sha256: "a".repeat(64),
  };
  store.list = async function* () {
    yield { ...frame, owner: "foreign" };
  };
  await assert.rejects(
    registry.collect(fence, "sweep"),
    /Ambiguous object inventory/,
  );
  store.list = async function* () {
    yield frame;
    yield frame;
  };
  await assert.rejects(
    registry.collect(fence, "sweep"),
    /Ambiguous object inventory/,
  );
  assert.equal(deletions, 0);
});

test("an omitted known object invalidates a supposedly complete inventory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-inventory-omitted-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const store = new LocalCheckpointStore(join(directory, "objects"));
  const fence = { owner: "owner", sandbox: "box", generation: 1 };
  const registry = new CheckpointRegistry(state, store);
  await registry.initialize(fence);
  const data = Buffer.from("retained");
  const object = await store.put(
    { ...fence, id: "object" },
    (async function* () {
      yield data;
    })(),
    {
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    },
  );
  await registry.admit(fence, "writer", "writer");
  await registry.publish(fence, "writer", "root", [object]);
  store.list = async function* () {};
  let deletes = 0;
  store.delete = async () => {
    deletes++;
  };
  await assert.rejects(
    registry.collect(fence, "sweep"),
    /Incomplete inventory/,
  );
  assert.equal(deletes, 0);
  assert.ok(await store.head(object));
});
