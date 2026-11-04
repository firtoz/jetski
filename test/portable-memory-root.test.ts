import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { checkpointArchive } from "../src/core/checkpoint-layout.js";
import {
  CheckpointRegistry,
  type CheckpointRoot,
} from "../src/core/checkpoints.js";
import { DEFAULTS, type Json } from "../src/core/contracts.js";
import type { PortableMemoryManifest } from "../src/core/portable-memory-format.js";
import {
  composePortableMemoryRoot,
  portableMemoryRoot,
} from "../src/core/portable-memory-root.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const scope = { owner: "owner", sandbox: "sandbox" },
  fence = { ...scope, generation: 1 };
const fsBytes = gzipSync(Buffer.from("filesystem checkpoint fixture")),
  memoryBytes = Buffer.from([0, 255, 128, 1]);
const fsObject = {
  ...scope,
  id: "filesystem",
  bytes: fsBytes.length,
  sha256: hash(fsBytes),
};
const memoryObject = {
  ...scope,
  id: "memory",
  bytes: memoryBytes.length,
  sha256: hash(memoryBytes),
};
function fixture(id = "save"): CheckpointRoot {
  const filesystem: CheckpointRoot = {
    id,
    frames: [fsObject],
    metadata: {
      version: 1,
      sha256: hash(fsBytes),
      bytes: fsBytes.length,
      expandedBytes: 29,
      entries: 2,
      frames: [
        {
          offset: 0,
          bytes: fsBytes.length,
          expandedBytes: 29,
          sha256: hash(fsBytes),
          expandedSha256: "b".repeat(64),
        },
      ],
    },
    publishedAt: 0,
    retiredAt: null,
    pins: [],
  };
  const manifest: PortableMemoryManifest = {
    ...scope,
    kind: "portable-memory",
    version: 1,
    checkpointId: id,
    generation: 1,
    filesystemSha256: hash(fsBytes),
    compatibility: {
      runtimeSha256: "a".repeat(64),
      hostAbiSha256: "a".repeat(64),
      image: "example/linux@sha256:" + "a".repeat(64),
      configurationSha256: "a".repeat(64),
      platform: "systrap",
      kernelVersion: "6.14.0",
      cpuFeatures: ["sse", "sse2"],
    },
    directories: [],
    files: [
      {
        path: "pages.img",
        bytes: memoryBytes.length,
        sha256: hash(memoryBytes),
        chunks: [
          {
            offset: 0,
            bytes: memoryBytes.length,
            sha256: hash(memoryBytes),
            codec: "identity",
            object: memoryObject,
          },
        ],
      },
    ],
  };
  return composePortableMemoryRoot(filesystem, manifest);
}
test("composite roots retain complete memory reachability and project unchanged filesystem layout", () => {
  const root = fixture(),
    projected = portableMemoryRoot(root)!;
  assert.deepEqual(root.frames, [fsObject, memoryObject]);
  assert.deepEqual(projected.filesystem.frames, [fsObject]);
  assert.equal(checkpointArchive(root).sha256, hash(fsBytes));
  for (const mutate of [
    (r: CheckpointRoot) => r.frames.pop(),
    (r: CheckpointRoot) => r.frames.push({ ...memoryObject, id: "hidden" }),
    (r: CheckpointRoot) => {
      (r.metadata as Record<string, Json>).filesystem = {
        ...((r.metadata as Record<string, Json>).filesystem as Record<
          string,
          Json
        >),
        sha256: "f".repeat(64),
      };
    },
    (r: CheckpointRoot) => {
      r.id = "another";
    },
  ]) {
    const changed = structuredClone(root);
    mutate(changed);
    assert.throws(() => checkpointArchive(changed));
  }
});
test("atomic publication refuses a missing memory object and reused chunks survive retirement/collection", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-portable-root-")),
    state = new SqliteState(join(directory, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const store = new LocalCheckpointStore(join(directory, "objects"));
  let now = 1000000;
  const registry = new CheckpointRegistry(state, store, () => now),
    root = fixture();
  await registry.initialize(fence);
  await registry.admit(fence, "writer1", "writer");
  await store.put(
    fsObject,
    (async function* () {
      yield fsBytes;
    })(),
    fsObject,
  );
  await assert.rejects(
    registry.publish(fence, "writer1", root.id, root.frames, root.metadata),
    /integrity/,
  );
  assert.equal(await registry.root(fence, root.id), undefined);
  await store.put(
    memoryObject,
    (async function* () {
      yield memoryBytes;
    })(),
    memoryObject,
  );
  await registry.publish(fence, "writer1", root.id, root.frames, root.metadata);
  const next = fixture("save2");
  await registry.admit(fence, "writer2", "writer");
  await registry.publish(fence, "writer2", next.id, next.frames, next.metadata);
  await registry.retire(fence, root.id);
  now += DEFAULTS.gcGraceMs + 1;
  await registry.collect(fence, "collection");
  assert(await store.head(memoryObject));
  assert(await store.head(fsObject));
  assert(await registry.root(fence, next.id));
});
