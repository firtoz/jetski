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

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

test("a superseded collector cannot finish stale inventory or delete retained data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-collector-race-"));
  const a = new SqliteState(join(directory, "state.sqlite"));
  const b = new SqliteState(join(directory, "state.sqlite"));
  t.after(async () => {
    a.close();
    b.close();
    await rm(directory, { recursive: true, force: true });
  });
  const store = new LocalCheckpointStore(join(directory, "objects"));
  const fence = { owner: "owner", sandbox: "box", generation: 1 };
  let now = 100;
  const first = new CheckpointRegistry(a, store, () => now);
  const second = new CheckpointRegistry(b, store, () => now);
  await first.initialize(fence);
  const frames: ObjectInfo[] = [];
  for (const id of ["orphan", "retained"]) {
    const data = Buffer.from(id);
    frames.push(
      await store.put(
        { ...fence, id },
        (async function* () {
          yield data;
        })(),
        {
          bytes: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
        },
      ),
    );
  }
  await first.admit(fence, "writer", "writer");
  await first.publish(fence, "writer", "root", [frames[1]!]);
  await first.collect(fence, "mark");
  now += DEFAULTS.gcGraceMs;
  const entered = gate(),
    resume = gate();
  const originalList = store.list.bind(store);
  let listings = 0;
  store.list = async function* (scope) {
    const ordinal = ++listings;
    for await (const object of originalList(scope)) {
      yield object;
      if (ordinal === 1) {
        entered.release();
        await resume.wait;
      }
    }
  };
  const stale = first.collect(fence, "sweep");
  // Attach the rejection handler before allowing either concurrent operation to finish.
  const rejected = assert.rejects(stale, /fenced/);
  await entered.wait;
  await assert.rejects(second.collect(fence, "different"), /Different/);
  await assert.rejects(
    second.admit(fence, "reader", "reader", "root"),
    /Collection/,
  );
  await assert.rejects(
    second.admit(fence, "new-writer", "writer"),
    /Collection/,
  );
  const deleted: string[] = [];
  const originalDelete = store.delete.bind(store);
  store.delete = async (address) => {
    deleted.push(address.id);
    await originalDelete(address);
  };
  assert.deepEqual(await second.collect(fence, "sweep"), { deleted: 1 });
  resume.release();
  await rejected;
  assert.deepEqual(deleted, ["orphan"]);
  assert.ok(await store.head(frames[1]!));
  assert.deepEqual(await first.collect(fence, "sweep"), { deleted: 1 });
});

test("corrupt observation and forged collection candidates never authorize deletion", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-collector-corrupt-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const store = new LocalCheckpointStore(join(directory, "objects"));
  const fence = { owner: "owner", sandbox: "box", generation: 1 };
  let now = 100;
  const registry = new CheckpointRegistry(state, store, () => now);
  await registry.initialize(fence);
  const data = Buffer.from("bytes");
  const frame = await store.put(
    { ...fence, id: "object" },
    (async function* () {
      yield data;
    })(),
    {
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    },
  );
  await registry.collect(fence, "mark");
  now += DEFAULTS.gcGraceMs;
  let deletes = 0;
  store.delete = async () => {
    deletes++;
  };
  for (const firstSeen of [-1, "100", null]) {
    await state.transaction((tx) =>
      tx.put("checkpoint-object/owner/box/object", {
        object: frame,
        firstSeen,
      }),
    );
    await assert.rejects(
      registry.collect(fence, "sweep"),
      /Ambiguous object observation/,
    );
  }
  await state.transaction((tx) => {
    tx.put("checkpoint-object/owner/box/object", {
      object: frame,
      firstSeen: 100,
    });
    tx.put("checkpoint-collection/owner/box/sweep", {
      generation: 1,
      candidates: [{ ...frame, owner: "foreign" }],
      next: 0,
      done: false,
    });
  });
  await assert.rejects(
    registry.collect(fence, "sweep"),
    /Ambiguous collection journal/,
  );
  assert.equal(deletes, 0);
  assert.ok(await store.head(frame));
});
