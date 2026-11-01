import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CheckpointRegistry,
  type CheckpointStore,
  type ObjectInfo,
} from "../src/core/index.js";
import { verifyCheckpointObjects } from "../src/core/object-verification.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "jetski-verification-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const store = new LocalCheckpointStore(join(directory, "objects"));
  const fence = { owner: "owner", sandbox: "sandbox", generation: 1 };
  const frames: ObjectInfo[] = [];
  for (let index = 0; index < 4; index++) {
    const bytes = Buffer.from(`frame-${index}`);
    const info = {
      ...fence,
      id: `frame-${index}`,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    frames.push(
      await store.put(
        info,
        (async function* () {
          yield bytes;
        })(),
        info,
      ),
    );
  }
  return { state, store, fence, frames };
}
function wrapper(
  store: CheckpointStore,
  head: CheckpointStore["head"],
  concurrency?: number,
): CheckpointStore {
  return {
    put: store.put.bind(store),
    head,
    read: store.read.bind(store),
    list: store.list.bind(store),
    delete: store.delete.bind(store),
    ...(concurrency === undefined
      ? {}
      : { verificationConcurrency: concurrency }),
  };
}

test("publication overlaps opted-in verification, deduplicates identities and retains archive order", async (t) => {
  const f = await fixture(t);
  const pending: (() => void)[] = [];
  let started!: () => void;
  const allStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let active = 0,
    maximum = 0,
    calls = 0;
  const store = wrapper(
    f.store,
    (info) =>
      new Promise((resolve, reject) => {
        calls++;
        active++;
        maximum = Math.max(maximum, active);
        pending.push(() => {
          void f.store.head(info).then(
            (value) => {
              active--;
              resolve(value);
            },
            (error) => {
              active--;
              reject(error);
            },
          );
        });
        if (calls === 4) started();
      }),
    4,
  );
  const registry = new CheckpointRegistry(f.state, store);
  await registry.initialize(f.fence);
  await registry.admit(f.fence, "writer", "writer");
  const ordered = [...f.frames, f.frames[0]!];
  let settled = false;
  const publication = registry
    .publish(f.fence, "writer", "root", ordered)
    .finally(() => {
      settled = true;
    });
  await allStarted;
  assert.equal(maximum, 4);
  assert.equal(settled, false);
  for (const release of pending.splice(1).reverse()) release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    settled,
    false,
    "one unfinished verification must prevent publication",
  );
  pending[0]!();
  await publication;
  assert.equal(active, 0);
  assert.equal(calls, 4);
  assert.deepEqual((await registry.root(f.fence, "root"))?.frames, ordered);
});

test("failed verification drains its batch, prevents publication and retains writer exclusion", async (t) => {
  const f = await fixture(t);
  let started!: () => void;
  const allStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending: (() => void)[] = [];
  let calls = 0,
    active = 0;
  const store = wrapper(
    f.store,
    (info) =>
      new Promise((resolve) => {
        calls++;
        if (calls > 4) throw Error("Unexpected next verification batch");
        active++;
        pending.push(() => {
          active--;
          resolve(
            info.id === f.frames[0]!.id
              ? {
                  ...f.frames.find((frame) => frame.id === info.id)!,
                  sha256: "0".repeat(64),
                }
              : { ...f.frames.find((frame) => frame.id === info.id)! },
          );
        });
        if (calls === 4) started();
      }),
    4,
  );
  const registry = new CheckpointRegistry(f.state, store);
  await registry.initialize(f.fence);
  await registry.admit(f.fence, "writer", "writer");
  let settled = false;
  const publication = registry.publish(f.fence, "writer", "root", [
    ...f.frames,
    { ...f.frames[0]!, id: "must-not-start" },
  ]);
  const checked = assert.rejects(publication, /integrity/).then(() => {
    settled = true;
  });
  await allStarted;
  pending[0]!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(active, 3);
  for (const release of pending.slice(1)) release();
  await checked;
  assert.equal(active, 0);
  assert.equal(calls, 4, "failure must not start another batch");
  assert.equal(await registry.root(f.fence, "root"), undefined);
  await assert.rejects(registry.collect(f.fence, "collector"), /Active/);
});

test("revoking a writer during parallel verification cannot publish its root", async (t) => {
  const f = await fixture(t);
  let started!: () => void;
  const allStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending: (() => void)[] = [];
  let calls = 0;
  const store = wrapper(
    f.store,
    (info) =>
      new Promise((resolve) => {
        pending.push(() =>
          resolve({ ...f.frames.find((frame) => frame.id === info.id)! }),
        );
        if (++calls === 4) started();
      }),
    4,
  );
  const registry = new CheckpointRegistry(f.state, store);
  await registry.initialize(f.fence);
  await registry.admit(f.fence, "writer", "writer");
  const publication = registry.publish(f.fence, "writer", "root", f.frames);
  const checked = assert.rejects(publication, /no longer admitted/);
  await allStarted;
  await registry.close(f.fence, "writer");
  for (const release of pending) release();
  await checked;
  assert.equal(await registry.root(f.fence, "root"), undefined);
});

test("custom adapters remain serial and invalid hints or conflicting identities fail before I/O", async (t) => {
  const f = await fixture(t);
  let active = 0,
    maximum = 0,
    calls = 0;
  const store = wrapper(f.store, async (info) => {
    calls++;
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return { ...f.frames.find((frame) => frame.id === info.id)! };
  });
  await verifyCheckpointObjects(store, f.fence, f.frames);
  assert.equal(maximum, 1);
  assert.equal(calls, 4);
  for (const concurrency of [2, 3]) {
    maximum = 0;
    await verifyCheckpointObjects(
      { ...store, verificationConcurrency: concurrency },
      f.fence,
      f.frames,
    );
    assert.equal(maximum, concurrency);
  }
  const verifiedCalls = calls;
  for (const concurrency of [0, 5, Number.NaN]) {
    await assert.rejects(
      verifyCheckpointObjects(
        { ...store, verificationConcurrency: concurrency },
        f.fence,
        f.frames,
      ),
      /concurrency/,
    );
  }
  await assert.rejects(
    verifyCheckpointObjects(store, f.fence, [
      f.frames[0]!,
      { ...f.frames[0]!, sha256: "0".repeat(64) },
    ]),
    /Conflicting/,
  );
  await assert.rejects(
    verifyCheckpointObjects(store, f.fence, [
      f.frames[0]!,
      { ...f.frames[1]!, owner: "foreign" },
    ]),
    /Cross-owner/,
  );
  assert.equal(
    calls,
    verifiedCalls,
    "invalid admission must perform no storage I/O",
  );
  await assert.rejects(
    verifyCheckpointObjects(
      wrapper(
        f.store,
        async (info) => ({
          ...f.frames.find((frame) => frame.id === info.id)!,
          id: "foreign-object",
        }),
        4,
      ),
      f.fence,
      f.frames,
    ),
    /integrity/,
  );
});

test("an adapter cannot mutate the publication expectations through its address argument", async (t) => {
  const f = await fixture(t);
  const originals = structuredClone(f.frames);
  const store = wrapper(
    f.store,
    async (address) => {
      const actual = { ...f.frames.find((frame) => frame.id === address.id)! };
      address.id = "changed-address";
      return { ...actual, id: address.id };
    },
    4,
  );
  await assert.rejects(
    verifyCheckpointObjects(store, f.fence, f.frames),
    /integrity/,
  );
  assert.deepEqual(f.frames, originals);
});
