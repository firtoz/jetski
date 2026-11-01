import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { CheckpointCopy } from "../src/core/checkpoint-copy.js";
import {
  checkpointArchive,
  checkpointLayout,
  type PackedArchive,
} from "../src/core/checkpoint-layout.js";
import {
  CheckpointRegistry,
  type CheckpointRoot,
} from "../src/core/checkpoints.js";
import { DEFAULTS, type Json, type ObjectInfo } from "../src/core/contracts.js";
import { restoreCheckpoint } from "../src/core/restore.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "jetski-packed-layout-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const objects = new LocalCheckpointStore(join(directory, "objects"));
  let now = 1;
  const registry = new CheckpointRegistry(state, objects, () => now);
  const fence = { owner: "owner", sandbox: "source", generation: 1 };
  await registry.initialize(fence);
  const plain = ["one", "two", "three", "one"].map((part) => Buffer.from(part)),
    parts = plain.map((part) => gzipSync(part));
  const bytes = Buffer.concat(parts);
  let offset = 0;
  const archive = {
    version: 1 as const,
    sha256: sha(bytes),
    bytes: bytes.length,
    expandedBytes: plain.reduce((n, p) => n + p.length, 0),
    entries: 2,
    frames: parts.map((part, index) => {
      const frame = {
        offset,
        bytes: part.length,
        sha256: sha(part),
        expandedBytes: plain[index]!.length,
        expandedSha256: sha(plain[index]!),
      };
      offset += part.length;
      return frame;
    }),
  };
  const payloads = [
    Buffer.concat([
      parts[0]!,
      parts[2]!,
      Buffer.from("unused retained extent"),
    ]),
    parts[1]!,
  ];
  const frames: ObjectInfo[] = [];
  for (const [index, payload] of payloads.entries())
    frames.push(
      await objects.put(
        { ...fence, id: `pack-${index}` },
        (async function* () {
          yield payload;
        })(),
        { bytes: payload.length, sha256: sha(payload) },
      ),
    );
  const metadata: PackedArchive = {
    kind: "filesystem-packs",
    version: 1,
    archive,
    segments: [
      { object: 0, offset: 0 },
      { object: 1, offset: 0 },
      { object: 0, offset: parts[0]!.length },
      { object: 0, offset: 0 },
    ],
  };
  const root: CheckpointRoot = {
    id: "root",
    frames,
    metadata: metadata as unknown as Json,
    publishedAt: now,
    retiredAt: null,
    pins: [],
  };
  const publish = async () => {
    await registry.admit(fence, "save", "writer");
    await registry.publish(fence, "save", "root", frames, root.metadata);
  };
  return {
    state,
    objects,
    registry,
    fence,
    frames,
    metadata,
    root,
    bytes,
    parts,
    publish,
    advance: () => {
      now += DEFAULTS.gcGraceMs;
    },
  };
}

async function restored(
  f: Awaited<ReturnType<typeof fixture>>,
  fence = f.fence,
  id = "root",
) {
  const root = (await f.registry.root(fence, id))!,
    archive = checkpointArchive(root);
  const receipt = {
    id,
    sha256: archive.sha256,
    bytes: archive.bytes,
    offset: 0,
    phase: "receiving",
  };
  const chunks: Buffer[] = [];
  await restoreCheckpoint(
    f.objects,
    f.registry,
    fence,
    id,
    async (action, payload) => {
      if (action === "import-begin")
        return { ...receipt, chunkBytes: 512 * 1024 };
      if (action === "import-chunk") {
        const part = payload as {
          offset: number;
          base64: string;
          sha256: string;
        };
        assert.equal(part.offset, receipt.offset);
        const bytes = Buffer.from(part.base64, "base64");
        assert.equal(sha(bytes), part.sha256);
        chunks.push(bytes);
        receipt.offset += bytes.length;
        return { ...receipt };
      }
      assert.equal(action, "import-finish");
      assert.equal(receipt.offset, receipt.bytes);
      receipt.phase = "ready";
      return { ...receipt };
    },
  );
  return Buffer.concat(chunks);
}

test("packed layout validates extents and retains legacy root decoding", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(checkpointArchive(f.root), f.metadata.archive);
  assert.equal(checkpointLayout(f.root).packed, true);
  const legacy = {
    ...f.root,
    frames: [f.frames[1]!],
    metadata: {
      ...f.metadata.archive,
      sha256: sha(f.parts[1]!),
      bytes: f.parts[1]!.length,
      expandedBytes: 3,
      frames: [{ ...f.metadata.archive.frames[1]!, offset: 0 }],
    } as unknown as Json,
  };
  assert.equal(checkpointLayout(legacy).packed, false);
  assert.deepEqual(checkpointLayout(legacy).segments, [
    { object: 0, offset: 0 },
  ]);
  for (const mutate of [
    (m: PackedArchive) => {
      m.segments[0]!.object = 9;
    },
    (m: PackedArchive) => {
      m.segments[0]!.offset = -1;
    },
    (m: PackedArchive) => {
      m.segments[2]!.offset = 1;
    },
    (m: PackedArchive) => {
      m.segments.pop();
    },
    (m: PackedArchive) => {
      m.segments[1]!.offset = 100000;
    },
    (m: PackedArchive) => {
      m.segments[1]!.object = 0;
    },
  ]) {
    const metadata = structuredClone(f.metadata);
    mutate(metadata);
    assert.throws(() =>
      checkpointLayout({ ...f.root, metadata: metadata as unknown as Json }),
    );
  }
  assert.throws(
    () =>
      checkpointLayout({
        ...f.root,
        frames: [...f.frames, { ...f.frames[0]!, id: "unused" }],
      }),
    /Unreferenced/,
  );
  assert.throws(
    () => checkpointLayout({ ...f.root, frames: [f.frames[0]!, f.frames[0]!] }),
    /Invalid packed/,
  );
});

test("publication rejects false slice claims even when the whole physical pack hash is correct", async (t) => {
  const f = await fixture(t),
    bad = structuredClone(f.metadata);
  bad.archive.frames[1]!.sha256 = "0".repeat(64);
  await f.registry.admit(f.fence, "save", "writer");
  await assert.rejects(
    f.registry.publish(
      f.fence,
      "save",
      "bad",
      f.frames,
      bad as unknown as Json,
    ),
    /slice integrity/,
  );
  assert.equal(await f.registry.root(f.fence, "bad"), undefined);
  await assert.rejects(f.registry.collect(f.fence, "blocked"), /Active/);
  await f.registry.publish(f.fence, "save", "root", f.frames, f.root.metadata);
  assert.deepEqual(await restored(f), f.bytes);
});

test("restore reorders verified slices with a bounded cache and copy survives source collection", async (t) => {
  const f = await fixture(t);
  await f.publish();
  const read = f.objects.read.bind(f.objects);
  let reads = 0;
  f.objects.read = (...args) => {
    reads++;
    return read(...args);
  };
  const bytes = await restored(f);
  assert.deepEqual(bytes, f.bytes);
  assert.equal(gunzipSync(bytes).toString(), "onetwothreeone");
  assert.equal(
    reads,
    2,
    "oldpack/newpack/oldpack requires no repeated physical download",
  );
  const target = { ...f.fence, sandbox: "replacement" };
  await f.registry.initialize(target);
  const copy = new CheckpointCopy(f.state, f.registry, f.objects);
  await copy.start(f.fence, target, "copy", "root");
  assert.equal((await copy.advance(target, "copy")).phase, "published");
  await f.registry.retire(f.fence, "root");
  f.advance();
  assert.deepEqual(await f.registry.collect(f.fence, "source-gc"), {
    deleted: 2,
  });
  for (const object of f.frames)
    assert.equal(await f.objects.head(object), undefined);
  assert.deepEqual(await restored(f, target, "copy"), f.bytes);
});

test("GC verifies retained slices before deleting an unrelated expired orphan", async (t) => {
  const f = await fixture(t);
  await f.publish();
  await f.registry.pin(f.fence, "root", "keep", true);
  const orphan = Buffer.from("orphan"),
    address = { ...f.fence, id: "orphan" };
  await f.objects.put(
    address,
    (async function* () {
      yield orphan;
    })(),
    { bytes: orphan.length, sha256: sha(orphan) },
  );
  assert.deepEqual(await f.registry.collect(f.fence, "observe"), {
    deleted: 0,
  });
  f.advance();
  await f.state.transaction((tx) => {
    const key = `checkpoint/${f.fence.owner}/${f.fence.sandbox}`;
    const record = tx.get(key) as unknown as {
      roots: { metadata: PackedArchive }[];
    };
    record.roots[0]!.metadata.archive.frames[1]!.sha256 = "0".repeat(64);
    tx.put(key, record as unknown as Json);
  });
  await assert.rejects(
    f.registry.collect(f.fence, "collect"),
    /slice integrity/,
  );
  assert.ok(
    await f.objects.head(address),
    "no deletion before complete retained proof",
  );
  await f.state.transaction((tx) => {
    const key = `checkpoint/${f.fence.owner}/${f.fence.sandbox}`;
    const record = tx.get(key) as unknown as {
      roots: { metadata: PackedArchive }[];
    };
    record.roots[0]!.metadata = structuredClone(f.metadata);
    tx.put(key, record as unknown as Json);
  });
  assert.deepEqual(await f.registry.collect(f.fence, "collect"), {
    deleted: 1,
  });
  assert.deepEqual(await f.registry.collect(f.fence, "collect"), {
    deleted: 1,
  });
  assert.deepEqual(await restored(f), f.bytes);
  assert.deepEqual(await f.registry.collect(f.fence, "again"), { deleted: 0 });
});

test("retiring a root never deletes a pack still used by another retained slice", async (t) => {
  const f = await fixture(t);
  await f.publish();
  const part = f.metadata.archive.frames[0]!;
  const metadata: PackedArchive = {
    kind: "filesystem-packs",
    version: 1,
    archive: {
      ...f.metadata.archive,
      sha256: part.sha256,
      bytes: part.bytes,
      expandedBytes: part.expandedBytes,
      frames: [{ ...part, offset: 0 }],
    },
    segments: [{ object: 0, offset: 0 }],
  };
  await f.registry.admit(f.fence, "partial-save", "writer");
  await f.registry.publish(
    f.fence,
    "partial-save",
    "partial",
    [f.frames[0]!],
    metadata as unknown as Json,
  );
  await f.registry.retire(f.fence, "root");
  f.advance();
  assert.deepEqual(await f.registry.collect(f.fence, "retired"), {
    deleted: 1,
  });
  assert.ok(
    await f.objects.head(f.frames[0]!),
    "entire shared pack is retained, including unused extents",
  );
  assert.equal(await f.objects.head(f.frames[1]!), undefined);
  assert.deepEqual(await restored(f, f.fence, "partial"), f.parts[0]);
});

test("restore drops exhausted packs before evicting a sparse pack with future members", async (t) => {
  const f = await fixture(t),
    payload = f.parts[2]!;
  const third = await f.objects.put(
    { ...f.fence, id: "pack-2" },
    (async function* () {
      yield payload;
    })(),
    { bytes: payload.length, sha256: sha(payload) },
  );
  const metadata = structuredClone(f.metadata);
  metadata.segments[2] = { object: 2, offset: 0 };
  await f.registry.admit(f.fence, "save", "writer");
  await f.registry.publish(
    f.fence,
    "save",
    "root",
    [...f.frames, third],
    metadata as unknown as Json,
  );
  const read = f.objects.read.bind(f.objects);
  let reads = 0;
  f.objects.read = (...args) => {
    reads++;
    return read(...args);
  };
  assert.deepEqual(await restored(f), f.bytes);
  assert.equal(
    reads,
    3,
    "a three-object sequence with only two live objects needs no repeated download",
  );
});
