import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import type { CapturedArchive } from "../src/core/archive-format.js";
import { CheckpointRegistry } from "../src/core/checkpoints.js";
import type { CheckpointStore } from "../src/core/contracts.js";
import {
  type CapturedMemory,
  parseMemoryCapture,
} from "../src/core/memory-capture.js";
import { identityMemoryCodec } from "../src/core/memory-chunk-codec.js";
import {
  type MemoryTransferMetrics,
  PortableMemoryTransfer,
} from "../src/core/memory-transfer.js";
import { portableMemoryRoot } from "../src/core/portable-memory-root.js";
import { CheckpointTransfer } from "../src/core/transfer.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";
import { gzipMemoryCodec } from "../src/storage/memory-codecs.js";

const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const fence = { owner: "owner", sandbox: "sandbox", generation: 1 };
const fsBytes = gzipSync(Buffer.from("filesystem fixture"));
const archive: CapturedArchive = {
  version: 1,
  bytes: fsBytes.length,
  sha256: hash(fsBytes),
  expandedBytes: 18,
  entries: 2,
  frames: [
    {
      offset: 0,
      bytes: fsBytes.length,
      expandedBytes: 18,
      sha256: hash(fsBytes),
      expandedSha256: "a".repeat(64),
    },
  ],
};
const compatibility = {
  runtimeSha256: "a".repeat(64),
  hostAbiSha256: "b".repeat(64),
  image: "example/linux@sha256:" + "a".repeat(64),
  configurationSha256: "c".repeat(64),
  platform: "systrap" as const,
  kernelVersion: "6.14.0",
  cpuFeatures: ["sse", "sse2"],
};
function sourceFixture(change = 0) {
  const files = [
    { path: "pages.img", bytes: Buffer.alloc(65536, 42) },
    { path: "checkpoint.img", bytes: Buffer.from(`kernel-${change}`) },
  ];
  const parts: Buffer[] = [],
    capture: CapturedMemory = {
      version: 1,
      bytes: 0,
      sha256: "",
      expandedBytes: 0,
      compatibility,
      directories: [],
      files: [],
    };
  for (const file of files) {
    const encoded = gzipSync(file.bytes);
    capture.files.push({
      path: file.path,
      bytes: file.bytes.length,
      sha256: hash(file.bytes),
      chunks: [
        {
          offset: 0,
          bytes: file.bytes.length,
          sha256: hash(file.bytes),
          codec: "gzip",
          packedOffset: capture.bytes,
          storedBytes: encoded.length,
          storedSha256: hash(encoded),
        },
      ],
    });
    parts.push(encoded);
    capture.bytes += encoded.length;
    capture.expandedBytes += file.bytes.length;
  }
  capture.files.sort((a, b) => a.path.localeCompare(b.path));
  const pack = Buffer.concat(parts);
  capture.sha256 = hash(pack);
  const reads: number[] = [];
  return {
    capture,
    pack,
    reads,
    source: {
      async read(offset: number, bytes: number) {
        reads.push(offset);
        return pack.subarray(offset, offset + bytes);
      },
    },
  };
}
const metrics = (): MemoryTransferMetrics => ({
  uploadedBytes: 0,
  reusedBytes: 0,
  sourceBytes: 0,
  sourceRequests: 0,
  uploads: 0,
});
const codecs = new Map([
  ["identity", identityMemoryCodec],
  ["gzip", gzipMemoryCodec],
] as const);

test("portable chunk upload survives lost PUT ACK/SQLite reopen and incremental checkpoints need no base chain", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jetski-mem-transfer-"));
  let state = new SqliteState(join(dir, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(dir, { recursive: true, force: true });
  });
  const local = new LocalCheckpointStore(join(dir, "objects"));
  let lose = true,
    physical = 0,
    puts = 0;
  const store: CheckpointStore = new Proxy(local, {
    get(target, key) {
      if (key === "put")
        return async (...args: Parameters<CheckpointStore["put"]>) => {
          const result = await target.put(...args);
          if (args[0].id.startsWith("mem-")) {
            puts++;
            if (lose) {
              lose = false;
              throw Error("Lost memory PUT acknowledgement");
            }
          }
          return result;
        };
      const v = Reflect.get(target, key, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  let registry = new CheckpointRegistry(state, store);
  await registry.initialize(fence);
  const first = sourceFixture(),
    firstMetrics = metrics();
  const run = async (
    id: string,
    input: ReturnType<typeof sourceFixture>,
    reuse: boolean,
    previous?: string,
  ) => {
    const transfer = new CheckpointTransfer(store, registry, () => "fs-" + id);
    const memory = new PortableMemoryTransfer(
      state,
      registry,
      store,
      codecs,
      () => `mem-${++physical}`,
    );
    return transfer.save(
      fence,
      id,
      archive,
      {
        async read(offset, bytes) {
          return fsBytes.subarray(offset, offset + bytes);
        },
      },
      previous,
      memory.publication(
        fence,
        id,
        archive.sha256,
        input.capture,
        input.source,
        { reuse, ...(previous ? { previous } : {}) },
        firstMetrics,
      ),
    );
  };
  await assert.rejects(run("first", first, true), /Lost memory/);
  assert.equal(await registry.root(fence, "first"), undefined);
  state.close();
  state = new SqliteState(join(dir, "state.sqlite"));
  registry = new CheckpointRegistry(state, store);
  const result = await run("first", first, true);
  assert(portableMemoryRoot(result.root));
  assert.equal(puts, 2);
  assert.deepEqual(first.reads, [
    0,
    first.capture.files[0]!.chunks[0]!.packedOffset,
  ]);
  const original = portableMemoryRoot(result.root)!.memory;
  const second = sourceFixture(1);
  const changed = await run("second", second, true, "first");
  const saved = portableMemoryRoot(changed.root)!.memory;
  assert.equal(puts, 3);
  assert.equal(second.reads.length, 1);
  assert.equal(
    saved.files[1]!.chunks[0]!.object.id,
    original.files[1]!.chunks[0]!.object.id,
  );
  await registry.retire(fence, "first");
  // The latest manifest is complete and declares every chunk it needs.
  assert.equal(saved.files.length, 2);
  assert.equal("baseCheckpoint" in saved, false);
  const before = puts;
  second.source.read = async () => {
    throw Error("Published retry cannot read native source");
  };
  await run("second", second, true, "first");
  assert.equal(puts, before);
});

test("memory capture refuses omitted/overlapping physical extents before upload", () => {
  const value = sourceFixture().capture;
  const missing = structuredClone(value);
  missing.files[0]!.chunks[0]!.packedOffset++;
  assert.throws(
    () => parseMemoryCapture(missing, fence, "save", archive.sha256),
    /gap|overlap/,
  );
  const changed = structuredClone(value);
  changed.files[0]!.chunks[0]!.storedSha256 = "invalid";
  assert.throws(() =>
    parseMemoryCapture(changed, fence, "save", archive.sha256),
  );
});

test("failed create-only attempts rotate IDs; corrupt source cannot publish memory", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jetski-mem-failure-"));
  const state = new SqliteState(join(dir, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(dir, { recursive: true, force: true });
  });
  const local = new LocalCheckpointStore(join(dir, "objects"));
  let fail = true,
    sequence = 0;
  const attempts: string[] = [];
  const store: CheckpointStore = new Proxy(local, {
    get(target, key) {
      if (key === "put")
        return async (...args: Parameters<CheckpointStore["put"]>) => {
          if (args[0].id.startsWith("attempt-")) {
            attempts.push(args[0].id);
            if (fail) {
              fail = false;
              throw Error("Failed before durable object");
            }
          }
          return target.put(...args);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const registry = new CheckpointRegistry(state, store);
  await registry.initialize(fence);
  const memory = new PortableMemoryTransfer(
    state,
    registry,
    store,
    codecs,
    () => `attempt-${++sequence}`,
  );
  let fsSequence = 0;
  const transfer = new CheckpointTransfer(
    store,
    registry,
    () => `fs-${++fsSequence}`,
  );
  const input = sourceFixture();
  const save = () =>
    transfer.save(
      fence,
      "save",
      archive,
      {
        async read(o, b) {
          return fsBytes.subarray(o, o + b);
        },
      },
      undefined,
      memory.publication(
        fence,
        "save",
        archive.sha256,
        input.capture,
        input.source,
        { reuse: false },
      ),
    );
  await assert.rejects(save(), /Failed/);
  assert.equal(await registry.root(fence, "save"), undefined);
  await save();
  assert.notEqual(attempts[0], attempts[1]);
  const bad = sourceFixture(2);
  bad.source.read = async (o, b) => Buffer.alloc(b, 0);
  await assert.rejects(
    transfer.save(
      fence,
      "corrupt",
      archive,
      {
        async read(o, b) {
          return fsBytes.subarray(o, o + b);
        },
      },
      undefined,
      memory.publication(
        fence,
        "corrupt",
        archive.sha256,
        bad.capture,
        bad.source,
        { reuse: false },
      ),
    ),
    /checksum/,
  );
  assert.equal(await registry.root(fence, "corrupt"), undefined);
});
