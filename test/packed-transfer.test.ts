import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { checkpointLayout } from "../src/core/checkpoint-layout.js";
import { CheckpointRegistry } from "../src/core/checkpoints.js";
import { CheckpointTransfer } from "../src/core/transfer.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function capture(raw: Buffer[]) {
  const parts = raw.map((part) => gzipSync(part)),
    bytes = Buffer.concat(parts);
  let offset = 0;
  const manifest = {
    version: 1 as const,
    sha256: sha(bytes),
    bytes: bytes.length,
    expandedBytes: raw.reduce((n, p) => n + p.length, 0),
    entries: 2,
    frames: parts.map((part, index) => {
      const frame = {
        offset,
        bytes: part.length,
        sha256: sha(part),
        expandedBytes: raw[index]!.length,
        expandedSha256: sha(raw[index]!),
      };
      offset += part.length;
      return frame;
    }),
  };
  return {
    bytes,
    manifest,
    source: {
      readConcurrency: 4,
      read: async (offset: number, count: number) =>
        bytes.subarray(offset, offset + count),
    },
  };
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "jetski-packed-save-"));
  let state = new SqliteState(join(dir, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(dir, { recursive: true, force: true });
  });
  const store = new LocalCheckpointStore(join(dir, "objects"));
  let registry = new CheckpointRegistry(state, store);
  const fence = { owner: "owner", sandbox: "sandbox", generation: 1 };
  await registry.initialize(fence);
  const transfer = new CheckpointTransfer(store, registry, undefined, {
    packBytes: 1024 * 1024,
  });
  const read = async (id: string) => {
    const root = (await registry.root(fence, id))!,
      layout = checkpointLayout(root),
      parts: Buffer[] = [];
    for (const [index, segment] of layout.segments.entries()) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of store.read(root.frames[segment.object]!))
        chunks.push(chunk);
      const frame = layout.archive.frames[index]!,
        part = Buffer.concat(chunks).subarray(
          segment.offset,
          segment.offset + frame.bytes,
        );
      assert.equal(sha(part), frame.sha256);
      parts.push(part);
    }
    const bytes = Buffer.concat(parts);
    assert.equal(sha(bytes), layout.archive.sha256);
    return bytes;
  };
  return {
    dir,
    get state() {
      return state;
    },
    store,
    get registry() {
      return registry;
    },
    fence,
    transfer,
    read,
    reopen() {
      state.close();
      state = new SqliteState(join(dir, "state.sqlite"));
      registry = new CheckpointRegistry(state, store);
      return { state, registry };
    },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("physical packs retain small-frame incremental uploads and exact ordered archive bytes", async (t) => {
  const f = await fixture(t),
    raw = Array.from({ length: 10 }, () => randomBytes(256 * 1024));
  const first = capture(raw),
    saved = await f.transfer.save(
      f.fence,
      "first",
      first.manifest,
      first.source,
    );
  assert.equal(
    saved.root.frames.length,
    4,
    "ten logical members fit into four bounded packs",
  );
  assert.equal(saved.uploadedBytes, first.bytes.length);
  assert.deepEqual(await f.read("first"), first.bytes);
  const changed = raw.map((part) => Buffer.from(part));
  changed[1]![30] = changed[1]![30]! ^ 1;
  const next = capture(changed),
    reads: number[] = [];
  const second = await f.transfer.save(
    f.fence,
    "second",
    next.manifest,
    {
      ...next.source,
      read: async (offset, count) => {
        reads.push(offset);
        return next.source.read(offset, count);
      },
    },
    "first",
  );
  const frame = next.manifest.frames[1]!;
  assert.ok(
    reads.every(
      (offset) => offset >= frame.offset && offset < frame.offset + frame.bytes,
    ),
  );
  assert.equal(second.uploadedBytes, frame.bytes);
  assert.equal(second.reusedBytes, next.bytes.length - frame.bytes);
  assert.equal(
    second.root.frames.length,
    5,
    "old shared pack retains its unchanged members",
  );
  assert.deepEqual(await f.read("second"), next.bytes);
  assert.equal(
    (await f.registry.root(f.fence, "first"))?.retiredAt,
    null,
    "history never silently expires",
  );
});

test("lost pack PUT acknowledgement survives SQLite reopen without rereading source", async (t) => {
  const f = await fixture(t),
    data = capture(Array.from({ length: 3 }, () => randomBytes(16000)));
  const put = f.store.put.bind(f.store);
  let puts = 0;
  f.store.put = async (...args) => {
    puts++;
    await put(...args);
    throw Error("pack ACK lost");
  };
  await assert.rejects(
    f.transfer.save(f.fence, "save", data.manifest, data.source),
    /ACK lost/,
  );
  assert.equal(await f.registry.root(f.fence, "save"), undefined);
  await assert.rejects(f.registry.collect(f.fence, "gc"), /Active/);
  const { registry } = f.reopen();
  const save = await new CheckpointTransfer(f.store, registry).save(
    f.fence,
    "save",
    data.manifest,
    {
      read: async () => {
        throw Error("source deleted");
      },
    },
  );
  assert.equal(puts, 1);
  assert.equal(save.uploadedBytes, 0);
  assert.equal(save.reusedBytes, data.bytes.length);
  assert.equal(
    checkpointLayout(save.root).packed,
    true,
    "persisted codec wins over changed defaults",
  );
  const replay = await new CheckpointTransfer(f.store, registry).save(
    f.fence,
    "save",
    data.manifest,
    {
      read: async () => {
        throw Error("source deleted");
      },
    },
  );
  assert.deepEqual(replay.root, save.root);
  assert.deepEqual(await f.read("save"), data.bytes);
});

test("wrong source member fails before physical publication and keeps writer exclusion", async (t) => {
  const f = await fixture(t),
    data = capture([randomBytes(1000), randomBytes(1000)]),
    bad = Buffer.from(data.bytes);
  bad[0] = bad[0]! ^ 1;
  let puts = 0;
  f.store.put = async () => {
    puts++;
    throw Error("must not upload");
  };
  await assert.rejects(
    f.transfer.save(f.fence, "bad", data.manifest, {
      read: async (offset, count) => bad.subarray(offset, offset + count),
    }),
    /source frame integrity/,
  );
  assert.equal(puts, 0);
  assert.equal(await f.registry.root(f.fence, "bad"), undefined);
  await assert.rejects(f.registry.collect(f.fence, "gc"), /Active/);
});

test("parallel pack failure drains its sibling, stops later batches and resumes committed identities", {
  timeout: 10000,
}, async (t) => {
  const f = await fixture(t),
    data = capture(Array.from({ length: 3 }, () => randomBytes(256 * 1024)));
  const transfer = new CheckpointTransfer(f.store, f.registry, undefined, {
    packBytes: 300 * 1024,
  });
  const put = f.store.put.bind(f.store),
    started = deferred(),
    failed = deferred(),
    release = deferred();
  let puts = 0,
    settled = false;
  f.store.put = async (...args) => {
    const index = puts++;
    if (puts === 2) started.resolve();
    await started.promise;
    const object = await put(...args);
    if (index === 0) {
      failed.resolve();
      throw Error("first pack ACK lost");
    }
    if (index === 1) await release.promise;
    return object;
  };
  const saving = transfer
    .save(f.fence, "save", data.manifest, data.source)
    .finally(() => {
      settled = true;
    });
  const rejected = assert.rejects(saving, /first pack ACK lost/);
  await failed.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(puts, 2);
  release.resolve();
  await rejected;
  assert.equal(await f.registry.root(f.fence, "save"), undefined);
  const reads: number[] = [];
  const saved = await transfer.save(f.fence, "save", data.manifest, {
    ...data.source,
    read: async (offset, count) => {
      reads.push(offset);
      return data.source.read(offset, count);
    },
  });
  assert.equal(puts, 3);
  assert.ok(reads.every((offset) => offset >= data.manifest.frames[2]!.offset));
  assert.equal(saved.uploadedBytes, data.manifest.frames[2]!.bytes);
  assert.deepEqual(await f.read("save"), data.bytes);
});

test("revoking a packed writer while a PUT is pending cannot publish", async (t) => {
  const f = await fixture(t),
    data = capture([randomBytes(1000)]),
    put = f.store.put.bind(f.store),
    started = deferred(),
    release = deferred();
  f.store.put = async (...args) => {
    const object = await put(...args);
    started.resolve();
    await release.promise;
    return object;
  };
  const saving = f.transfer.save(f.fence, "save", data.manifest, data.source),
    rejected = assert.rejects(saving, /Writer.*admitted|writer.*admitted/);
  await started.promise;
  await f.registry.close(f.fence, "save");
  release.resolve();
  await rejected;
  assert.equal(await f.registry.root(f.fence, "save"), undefined);
});

test("contiguous small members share bounded reads without losing individual hashes", async (t) => {
  const f = await fixture(t),
    raw = Array.from({ length: 12 }, () => randomBytes(128 * 1024)),
    data = capture(raw);
  const calls: Array<{ offset: number; bytes: number }> = [];
  const transfer = new CheckpointTransfer(f.store, f.registry, undefined, {
    packBytes: 8 * 1024 * 1024,
  });
  const result = await transfer.save(f.fence, "coalesced", data.manifest, {
    ...data.source,
    read: async (offset, bytes) => {
      calls.push({ offset, bytes });
      return data.source.read(offset, bytes);
    },
  });
  assert.equal(result.root.frames.length, 1);
  assert.ok(
    calls.length < raw.length,
    "cold save avoids one control round trip per logical member",
  );
  assert.ok(calls.every((call) => call.bytes <= 256 * 1024));
  assert.ok(calls.some((call) => call.bytes > data.manifest.frames[0]!.bytes));
  assert.equal(
    calls.reduce((total, call) => total + call.bytes, 0),
    data.bytes.length,
  );
  assert.deepEqual(await f.read("coalesced"), data.bytes);
});

test("ordered source preparation overlaps bounded storage uploads", {
  timeout: 2000,
}, async (t) => {
  const f = await fixture(t),
    archive = capture(Array.from({ length: 4 }, () => randomBytes(700_000)));
  let cursor = 0,
    active = 0,
    peak = 0,
    release!: () => void;
  const overlap = new Promise<void>((resolve) => {
    release = resolve;
  });
  const put = f.store.put.bind(f.store);
  f.store.put = async (...args) => {
    active++;
    peak = Math.max(peak, active);
    if (active >= 2) release();
    try {
      await overlap;
      return await put(...args);
    } finally {
      active--;
    }
  };
  const source = {
    readConcurrency: 1,
    read: async (offset: number, bytes: number) => {
      assert.equal(offset, cursor);
      cursor += bytes;
      return archive.bytes.subarray(offset, offset + bytes);
    },
  };
  await f.transfer.save(f.fence, "ordered", archive.manifest, source);
  assert.ok(peak >= 2 && peak <= 4);
  assert.equal(active, 0);
  assert.equal(cursor, archive.bytes.length);
  assert.deepEqual(await f.read("ordered"), archive.bytes);
});
