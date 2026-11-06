import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import type { CapturedArchive } from "../src/core/archive-format.js";
import { CheckpointCopy } from "../src/core/checkpoint-copy.js";
import { checkpointArchive } from "../src/core/checkpoint-layout.js";
import type { CheckpointPublication } from "../src/core/checkpoint-publication.js";
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
import { CheckpointTransfer } from "../src/core/transfer.js";
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

for (const packBytes of [0, 4 * 1024 * 1024])
  test(`memory extends atomic filesystem transfer and recovers publication ACK loss; pack=${packBytes}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "jetski-memory-transfer-"));
    const state = new SqliteState(join(directory, "state.sqlite"));
    t.after(async () => {
      state.close();
      await rm(directory, { recursive: true, force: true });
    });
    const store = new LocalCheckpointStore(join(directory, "objects"));
    const registry = new CheckpointRegistry(state, store);
    await registry.initialize(fence);
    const transfer = new CheckpointTransfer(
      store,
      registry,
      () => "filesystem",
      { packBytes },
    );
    const description = fixture();
    const original = portableMemoryRoot(description)!;
    let prepares = 0,
      reads = 0;
    const extension: CheckpointPublication = {
      async prepare(base) {
        prepares++;
        return composePortableMemoryRoot(base, original.memory);
      },
      validate(root) {
        assert.equal(
          portableMemoryRoot(root)?.memory.checkpointId,
          description.id,
        );
      },
    };
    const source = {
      async read(offset: number, bytes: number) {
        reads++;
        return fsBytes.subarray(offset, offset + bytes);
      },
    };
    await assert.rejects(
      transfer.save(
        fence,
        description.id,
        original.filesystem.metadata,
        source,
        undefined,
        extension,
      ),
      /integrity/,
    );
    assert.equal(await registry.root(fence, description.id), undefined);
    await assert.rejects(registry.collect(fence, "during-upload"), /Active/);
    await store.put(
      memoryObject,
      (async function* () {
        yield memoryBytes;
      })(),
      memoryObject,
    );
    const publish = registry.publish.bind(registry);
    let loseAck = true;
    registry.publish = async (...args) => {
      await publish(...args);
      if (loseAck) {
        loseAck = false;
        throw Error("Lost complete publication ACK");
      }
    };
    await assert.rejects(
      transfer.save(
        fence,
        description.id,
        original.filesystem.metadata,
        source,
        undefined,
        extension,
      ),
      /Lost/,
    );
    const readCount = reads;
    const result = await transfer.save(
      fence,
      description.id,
      original.filesystem.metadata,
      {
        async read() {
          throw Error("Published save must not read the source again");
        },
      },
      undefined,
      extension,
    );
    assert.equal(prepares, 2);
    assert.equal(reads, readCount);
    assert.equal(result.root.frames.length, 2);
    assert(portableMemoryRoot(result.root));
    assert.equal(
      checkpointArchive(result.root).sha256,
      (original.filesystem.metadata as unknown as CapturedArchive).sha256,
    );
  });

test("memory forks rebind the complete graph, retain independent objects and replay publication safely", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-memory-fork-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const objects = new LocalCheckpointStore(join(directory, "objects"));
  const registry = new CheckpointRegistry(state, objects);
  await registry.initialize(fence);
  await registry.admit(fence, "writer", "writer");
  for (const [object, bytes] of [
    [fsObject, fsBytes],
    [memoryObject, memoryBytes],
  ] as const)
    await objects.put(
      object,
      (async function* () {
        yield bytes;
      })(),
      object,
    );
  const root = fixture();
  await registry.publish(fence, "writer", root.id, root.frames, root.metadata);
  const publish = registry.publish.bind(registry);
  let losePublication = true;
  registry.publish = async (...args) => {
    await publish(...args);
    if (losePublication && args[0].sandbox === "branch-a") {
      losePublication = false;
      throw Error("memory publication ACK lost");
    }
  };
  const copier = new CheckpointCopy(state, registry, objects);
  const targets = ["branch-a", "branch-b"].map((sandbox) => ({
    ...fence,
    sandbox,
  }));
  for (const target of targets) {
    await copier.start(fence, target, "fork", root.id, "memory");
    await assert.rejects(
      copier.start(fence, target, "fork", root.id, "filesystem"),
      /identity conflict/,
    );
    if (target.sandbox === "branch-a")
      await assert.rejects(
        copier.advance(target, "fork"),
        /memory publication ACK lost/,
      );
    const result = await copier.advance(target, "fork");
    assert.equal(result.phase, "published");
    assert.equal((await copier.advance(target, "fork")).phase, "published");
    const copied = (await registry.root(target, "fork"))!;
    const memory = portableMemoryRoot(copied)!;
    assert.equal(memory.memory.sandbox, target.sandbox);
    assert.equal(memory.memory.checkpointId, "fork");
    assert.deepEqual(
      memory.memory.compatibility,
      portableMemoryRoot(root)!.memory.compatibility,
    );
    assert.equal(
      checkpointArchive(copied).sha256,
      checkpointArchive(root).sha256,
    );
    for (const object of copied.frames) {
      assert.equal(object.sandbox, target.sandbox);
      assert.equal(object.owner, fence.owner);
      assert.ok(!root.frames.some((original) => original.id === object.id));
      const chunks = [];
      for await (const chunk of objects.read(object)) chunks.push(chunk);
      assert.equal(hash(Buffer.concat(chunks)), object.sha256);
    }
    assert.equal(
      memory.memory.files[0]!.chunks[0]!.object.sandbox,
      target.sandbox,
    );
  }
  assert.equal(
    portableMemoryRoot((await registry.root(fence, root.id))!)!.memory.sandbox,
    scope.sandbox,
  );
  await assert.rejects(
    copier.start(
      fence,
      { ...targets[0]!, owner: "other" },
      "denied",
      root.id,
      "memory",
    ),
    /same-owner/,
  );
  const fsTarget = { ...fence, sandbox: "files-only" };
  await copier.start(fence, fsTarget, "files", root.id);
  await copier.advance(fsTarget, "files");
  assert.equal(
    portableMemoryRoot((await registry.root(fsTarget, "files"))!),
    undefined,
  );
  await assert.rejects(
    copier.start(
      fsTarget,
      { ...fence, sandbox: "invalid" },
      "no-memory",
      "files",
      "memory",
    ),
    /portable memory/,
  );
});
