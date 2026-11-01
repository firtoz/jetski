import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  CheckpointRegistry,
  CheckpointTransfer,
  parseArchive,
} from "../src/core/index.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function archive(parts: Buffer[]) {
  let offset = 0;
  const compressed = parts.map((part) => gzipSync(part));
  const bytes = Buffer.concat(compressed);
  return {
    bytes,
    manifest: {
      version: 1 as const,
      sha256: sha(bytes),
      bytes: bytes.length,
      expandedBytes: parts.reduce((n, p) => n + p.length, 0),
      entries: 2,
      frames: compressed.map((frame, index) => {
        const raw = parts[index];
        if (!raw) throw Error("fixture missing");
        const entry = {
          offset,
          bytes: frame.length,
          expandedBytes: raw.length,
          sha256: sha(frame),
          expandedSha256: sha(raw),
        };
        offset += frame.length;
        return entry;
      }),
    },
  };
}

test("incremental publication uploads only changed frames and survives source loss", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jetski-transfer-"));
  const state = new SqliteState(join(dir, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(dir, { recursive: true, force: true });
  });
  const store = new LocalCheckpointStore(join(dir, "objects"));
  const registry = new CheckpointRegistry(state, store);
  const fence = { owner: "alice", sandbox: "box", generation: 1 };
  await registry.initialize(fence);
  const transfer = new CheckpointTransfer(store, registry);
  const before = archive([Buffer.from("unchanged"), Buffer.from("before")]);
  const first = await transfer.save(fence, "first", before.manifest, {
    read: async (offset, count) =>
      before.bytes.subarray(offset, offset + count),
  });
  assert.equal(first.uploadedBytes, before.bytes.length);
  const after = archive([Buffer.from("unchanged"), Buffer.from("after!")]);
  const reads: number[] = [];
  const second = await transfer.save(
    fence,
    "second",
    after.manifest,
    {
      read: async (offset, count) => {
        reads.push(offset);
        return after.bytes.subarray(offset, offset + count);
      },
    },
    "first",
  );
  assert.deepEqual(reads, [after.manifest.frames[1]?.offset]);
  assert.equal(second.reusedBytes, after.manifest.frames[0]?.bytes);
  assert.equal(second.root.frames[0]?.id, first.root.frames[0]?.id);
  assert.notEqual(second.root.frames[1]?.id, first.root.frames[1]?.id);
  const replay = await transfer.save(fence, "second", after.manifest, {
    read: async () => {
      throw Error("source no longer exists");
    },
  });
  assert.deepEqual(replay.root, second.root);
  const recovered: Uint8Array[] = [];
  for (const frame of second.root.frames)
    for await (const chunk of store.read(frame)) recovered.push(chunk);
  const restored = Buffer.concat(recovered);
  assert.equal(sha(restored), after.manifest.sha256);
  assert.equal(gunzipSync(restored).toString(), "unchangedafter!");
  await assert.rejects(
    transfer.save(fence, "second", before.manifest, {
      read: async () => new Uint8Array(),
    }),
    /identity conflict/,
  );
});

test("short source read prevents publication and preserves writer exclusion", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jetski-transfer-"));
  const state = new SqliteState(join(dir, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(dir, { recursive: true, force: true });
  });
  const store = new LocalCheckpointStore(join(dir, "objects"));
  const registry = new CheckpointRegistry(state, store);
  const fence = { owner: "alice", sandbox: "box", generation: 1 };
  await registry.initialize(fence);
  const fixture = archive([Buffer.from("data")]);
  await assert.rejects(
    new CheckpointTransfer(store, registry).save(
      fence,
      "failed",
      fixture.manifest,
      { read: async () => new Uint8Array() },
    ),
    /Short/,
  );
  assert.equal(await registry.root(fence, "failed"), undefined);
  await assert.rejects(registry.collect(fence, "gc"), /Active/);
  const wrong = structuredClone(fixture.manifest);
  wrong.frames[0]!.offset = 1;
  assert.throws(() => parseArchive(wrong), /Invalid archive frame/);
});

test("upload identity journal recovers a lost store acknowledgement without resending committed frames", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jetski-save-recovery-"));
  const state = new SqliteState(join(dir, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(dir, { recursive: true, force: true });
  });
  const store = new LocalCheckpointStore(join(dir, "objects"));
  const registry = new CheckpointRegistry(state, store),
    fence = { owner: "alice", sandbox: "box", generation: 1 };
  await registry.initialize(fence);
  const fixture = archive([
    Buffer.from("committed before acknowledgement"),
    Buffer.from("remaining frame"),
  ]);
  const put = store.put.bind(store);
  let loseAck = true,
    puts = 0;
  store.put = async (...args) => {
    puts++;
    const saved = await put(...args);
    if (loseAck) {
      loseAck = false;
      throw Error("store acknowledgement lost");
    }
    return saved;
  };
  const reads: number[] = [];
  const source = {
    read: async (offset: number, count: number) => {
      reads.push(offset);
      return fixture.bytes.subarray(offset, offset + count);
    },
  };
  await assert.rejects(
    new CheckpointTransfer(store, registry).save(
      fence,
      "save",
      fixture.manifest,
      source,
    ),
    /acknowledgement lost/,
  );
  assert.equal(await registry.root(fence, "save"), undefined);
  await assert.rejects(registry.collect(fence, "gc"), /Active/);
  const conflict = archive([Buffer.from("changed input")]);
  await assert.rejects(
    new CheckpointTransfer(store, registry).save(
      fence,
      "save",
      conflict.manifest,
      source,
    ),
    /identity conflict/,
  );
  reads.length = 0;
  const restarted = new CheckpointTransfer(
    store,
    new CheckpointRegistry(state, store),
  );
  const recovered = await restarted.save(
    fence,
    "save",
    fixture.manifest,
    source,
  );
  assert.deepEqual(reads, [fixture.manifest.frames[1]!.offset]);
  assert.equal(puts, 2, "exactly one object upload per frame despite lost ACK");
  assert.equal(recovered.reusedBytes, fixture.manifest.frames[0]!.bytes);
  const chunks: Uint8Array[] = [];
  for (const frame of recovered.root.frames)
    for await (const chunk of store.read(frame)) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), fixture.bytes);
});

test("opt-in parallel ranges are bounded, ordered and drained before failure", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jetski-parallel-transfer-"));
  const state = new SqliteState(join(dir, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(dir, { recursive: true, force: true });
  });
  const store = new LocalCheckpointStore(join(dir, "objects"));
  const registry = new CheckpointRegistry(state, store);
  const fence = { owner: "alice", sandbox: "box", generation: 1 };
  await registry.initialize(fence);
  const fixture = archive([randomBytes(1024 * 1024 + 64)]);
  const transfer = new CheckpointTransfer(store, registry);
  let active = 0,
    maximum = 0,
    finished = 0;
  const pending: (() => void)[] = [];
  const source = (fail: boolean) => ({
    readConcurrency: 4,
    read(offset: number, count: number): Promise<Uint8Array> {
      active++;
      maximum = Math.max(maximum, active);
      return new Promise((resolve, reject) => {
        pending.push(() => {
          active--;
          finished++;
          if (fail && offset === 0) reject(Error("range failed"));
          else resolve(fixture.bytes.subarray(offset, offset + count));
        });
        // Complete the bounded batch in reverse order without timing assumptions.
        if (pending.length === 4 || offset + count === fixture.bytes.length) {
          for (const done of pending.splice(0).reverse()) done();
        }
      });
    },
  });
  const saved = await transfer.save(
    fence,
    "parallel",
    fixture.manifest,
    source(false),
  );
  assert.equal(maximum, 4);
  assert.equal(active, 0);
  const restored: Uint8Array[] = [];
  for (const frame of saved.root.frames)
    for await (const bytes of store.read(frame)) restored.push(bytes);
  assert.deepEqual(Buffer.concat(restored), fixture.bytes);
  finished = 0;
  await assert.rejects(
    transfer.save(fence, "failed-parallel", fixture.manifest, source(true)),
    /range failed/,
  );
  assert.equal(active, 0);
  assert.equal(finished, 4);
  assert.equal(await registry.root(fence, "failed-parallel"), undefined);
  await assert.rejects(registry.collect(fence, "gc"), /Active/);
  await assert.rejects(
    transfer.save(fence, "invalid", fixture.manifest, {
      ...source(false),
      readConcurrency: 5,
    }),
    /concurrency/,
  );
});

test("frame uploads share the range budget and drain a failed batch before replay", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jetski-frame-pipeline-"));
  const state = new SqliteState(join(dir, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(dir, { recursive: true, force: true });
  });
  const store = new LocalCheckpointStore(join(dir, "objects"));
  const registry = new CheckpointRegistry(state, store);
  const fence = { owner: "alice", sandbox: "box", generation: 1 };
  await registry.initialize(fence);
  const fixture = archive(
    Array.from({ length: 3 }, () => randomBytes(600_000)),
  );
  const put = store.put.bind(store);
  const failed = deferred();
  const release = deferred();
  const started = deferred();
  let uploads = 0,
    active = 0,
    maximum = 0,
    reads = 0;
  store.put = async (...args) => {
    const index = uploads++;
    if (uploads === 2) started.resolve();
    await started.promise;
    const object = await put(...args);
    if (index === 0) {
      failed.resolve();
      throw Error("lost upload acknowledgement");
    }
    if (index === 1) await release.promise;
    return object;
  };
  const source = {
    readConcurrency: 4,
    read: async (offset: number, count: number) => {
      reads++;
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      return fixture.bytes.subarray(offset, offset + count);
    },
  };
  let completed = false;
  const saving = new CheckpointTransfer(store, registry)
    .save(fence, "save", fixture.manifest, source)
    .finally(() => {
      completed = true;
    });
  const rejected = assert.rejects(saving, /lost upload acknowledgement/);
  await failed.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    completed,
    false,
    "sibling upload remains inside failed operation",
  );
  assert.equal(uploads, 2, "later batch must not start");
  release.resolve();
  await rejected;
  assert.equal(active, 0);
  assert.ok(maximum >= 2 && maximum <= 4, "uploads share the four-read budget");
  assert.equal(await registry.root(fence, "save"), undefined);
  await assert.rejects(registry.collect(fence, "gc"), /Active/);
  reads = 0;
  const recovered = await new CheckpointTransfer(store, registry).save(
    fence,
    "save",
    fixture.manifest,
    source,
  );
  assert.equal(uploads, 3, "both committed siblings reused after lost ACK");
  assert.equal(reads, 3, "only the remaining 600KB frame was read");
  const chunks: Uint8Array[] = [];
  for (const frame of recovered.root.frames)
    for await (const chunk of store.read(frame)) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), fixture.bytes);
});

test("capture tuning retains acknowledged four-MiB archive compatibility", () => {
  const old = archive([Buffer.alloc(4 * 1024 * 1024, 7)]);
  assert.deepEqual(parseArchive(old.manifest), old.manifest);
  const invalid = structuredClone(old.manifest);
  invalid.frames[0]!.expandedBytes++;
  assert.throws(() => parseArchive(invalid), /Invalid archive frame/);
});

test("parallel reuse checks each repeated immutable identity once per phase", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jetski-reuse-dedup-"));
  const state = new SqliteState(join(dir, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(dir, { recursive: true, force: true });
  });
  const store = new LocalCheckpointStore(join(dir, "objects"));
  const registry = new CheckpointRegistry(state, store);
  const fence = { owner: "alice", sandbox: "box", generation: 1 };
  await registry.initialize(fence);
  const fixture = archive([Buffer.from("identical"), Buffer.from("identical")]);
  const transfer = new CheckpointTransfer(store, registry);
  const source = {
    readConcurrency: 4,
    read: async (offset: number, count: number) =>
      fixture.bytes.subarray(offset, offset + count),
  };
  await transfer.save(fence, "first", fixture.manifest, source);
  const second = await transfer.save(
    fence,
    "second",
    fixture.manifest,
    source,
    "first",
  );
  assert.equal(second.root.frames[0]!.id, second.root.frames[1]!.id);
  const head = store.head.bind(store);
  const active = new Set<string>();
  let checks = 0;
  store.head = async (address) => {
    assert.equal(
      active.has(address.id),
      false,
      "same-key receipt checks cannot overlap",
    );
    active.add(address.id);
    checks++;
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      return await head(address);
    } finally {
      active.delete(address.id);
    }
  };
  const third = await transfer.save(
    fence,
    "third",
    fixture.manifest,
    {
      readConcurrency: 4,
      read: async () => {
        throw Error("unchanged source must not be read");
      },
    },
    "second",
  );
  assert.equal(checks, 2, "one reuse check and one final publication check");
  assert.equal(third.reusedBytes, fixture.bytes.length);
});
