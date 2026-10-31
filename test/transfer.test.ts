import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
