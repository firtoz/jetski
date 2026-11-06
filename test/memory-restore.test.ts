import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import type { CapturedArchive } from "../src/core/archive-format.js";
import { checkpointArchive } from "../src/core/checkpoint-layout.js";
import {
  CheckpointRegistry,
  type CheckpointRoot,
} from "../src/core/checkpoints.js";
import { canonical, type Json } from "../src/core/contracts.js";
import { PortableMemoryRestore } from "../src/core/memory-restore.js";
import type { HostLease } from "../src/core/pool.js";
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

const lease: HostLease = {
  owner: "owner",
  sandboxId: "sandbox",
  poolId: "pool",
  slotId: "slot",
  machineId: "replacement",
  assignmentId: "target",
  generation: 2,
};
const resources = { memoryMb: 512, cpus: 1 };
async function setup(
  t: { after: (f: () => Promise<void>) => void },
  objectCount = 1,
  concurrency: 1 | 2 | 4 = 1,
) {
  const dir = await mkdtemp(join(tmpdir(), "jetski-memory-restore-"));
  let state = new SqliteState(join(dir, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(dir, { recursive: true, force: true });
  });
  const store = new LocalCheckpointStore(join(dir, "objects"));
  let registry = new CheckpointRegistry(state, store);
  await registry.initialize(fence);
  let root = fixture();
  if (objectCount > 1) {
    const portable = portableMemoryRoot(root)!;
    root = composePortableMemoryRoot(portable.filesystem, {
      ...portable.memory,
      files: Array.from({ length: objectCount }, (_, i) => ({
        ...portable.memory.files[0]!,
        path: i === 0 ? "pages.img" : `pages${i}.img`,
        chunks: portable.memory.files[0]!.chunks.map((c) => ({
          ...c,
          object: { ...c.object, id: i === 0 ? "memory" : `memory-${i}` },
        })),
      })),
    });
  }
  await registry.admit(fence, "writer", "writer");
  for (const [object, bytes] of [
    [fsObject, fsBytes],
    ...portableMemoryRoot(root)!.memory.files.flatMap((f) =>
      f.chunks.map((c) => [c.object, memoryBytes] as const),
    ),
  ] as const)
    await store.put(
      object,
      (async function* () {
        yield bytes;
      })(),
      object,
    );
  await registry.publish(fence, "writer", root.id, root.frames, root.metadata);
  const manifest = portableMemoryRoot(root)!.memory,
    sha256 = hash(Buffer.from(canonical(manifest)));
  let phase = "receiving",
    finishes = 0,
    supported = true,
    loseChunk = false,
    loseFinish = false,
    uncertain = false,
    rejected = false,
    failObjectStatus = false,
    objectStatuses = 0;
  const offsets = new Map<string, number>();
  let beforeChunk: ((id: string) => Promise<void>) | undefined;
  const calls: string[] = [];
  const receipt = () => ({
    id: root.id,
    sha256,
    lease,
    filesystemSha256: manifest.filesystemSha256,
    phase,
    memoryPreserved: phase === "restored",
  });
  const request = async (action: string, payload: Json): Promise<Json> => {
    calls.push(action);
    const p = payload as Record<string, Json>;
    switch (action) {
      case "status":
        return { portableMemoryVersion: supported ? 1 : null };
      case "claim":
        return {};
      case "import-begin":
        assert.equal(p.portableMemoryRequired, supported ? true : undefined);
        return {
          id: root.id,
          sha256: hash(fsBytes),
          bytes: fsBytes.length,
          offset: fsBytes.length,
          phase: "ready",
        };
      case "memory-import-begin":
        assert.equal(p.image, manifest.compatibility.image);
        if (rejected) phase = "rejected";
        return receipt();
      case "memory-import-status":
        if (p.objectId) {
          objectStatuses++;
          if (failObjectStatus) {
            failObjectStatus = false;
            throw Error("status connection lost");
          }
        }
        return {
          ...receipt(),
          ...(p.objectId
            ? {
                object: {
                  id: String(p.objectId),
                  offset: offsets.get(String(p.objectId)) ?? 0,
                  complete:
                    offsets.get(String(p.objectId)) === memoryBytes.length,
                },
              }
            : {}),
        };
      case "memory-import-chunk": {
        const b = Buffer.from(String(p.base64), "base64");
        assert.deepEqual(b, memoryBytes);
        const objectId = String(p.objectId);
        await beforeChunk?.(objectId);
        const offset = offsets.get(objectId) ?? 0;
        assert.equal(p.offset, offset);
        assert.equal(p.sha256, hash(b));
        offsets.set(objectId, offset + b.length);
        if (loseChunk) {
          loseChunk = false;
          throw Error("lost chunk ACK");
        }
        return { id: objectId, offset: offset + b.length, complete: true };
      }
      case "memory-import-finish":
        finishes++;
        phase = uncertain ? "restoring" : "restored";
        if (loseFinish) {
          loseFinish = false;
          throw Error("lost native ACK");
        }
        return receipt();
      case "memory-import-abort":
        phase = "filesystem";
        return receipt();
      default:
        throw Error("unexpected " + action);
    }
  };
  return {
    store,
    request,
    calls,
    registry: () => registry,
    coordinator: () =>
      new PortableMemoryRestore(state, registry, store, undefined, concurrency),
    reopen() {
      state.close();
      state = new SqliteState(join(dir, "state.sqlite"));
      registry = new CheckpointRegistry(state, store);
    },
    configure(v: {
      supported?: boolean;
      loseChunk?: boolean;
      loseFinish?: boolean;
      uncertain?: boolean;
      rejected?: boolean;
      failObjectStatus?: boolean;
    }) {
      supported = v.supported ?? supported;
      loseChunk = v.loseChunk ?? loseChunk;
      loseFinish = v.loseFinish ?? loseFinish;
      uncertain = v.uncertain ?? uncertain;
      rejected = v.rejected ?? rejected;
      failObjectStatus = v.failObjectStatus ?? failObjectStatus;
    },
    observeRestored() {
      phase = "restored";
    },
    beforeChunk: (callback: (id: string) => Promise<void>) => {
      beforeChunk = callback;
    },
    finishes: () => finishes,
    objectStatuses: () => objectStatuses,
    journal: () =>
      state.transaction(
        (tx) => tx.scan<Record<string, Json>>("portable-restore/")[0]!.value,
      ),
    progress: () =>
      state.transaction((tx) =>
        Object.fromEntries(
          tx
            .scan<string>("portable-restore/")
            .filter((row) => row.key.includes("/object/"))
            .map((row) => [row.key.split("/").at(-1)!, row.value]),
        ),
      ),
    legacyJournal: () =>
      state.transaction((tx) => {
        const row = tx.scan<Record<string, Json>>("portable-restore/")[0]!;
        const {
          objectProgress: _progress,
          objectJournal: _version,
          ...record
        } = row.value;
        tx.put(row.key, record);
      }),
    run() {
      return this.coordinator().restore(
        fence,
        "restore",
        root.id,
        lease,
        manifest.compatibility.image,
        resources,
        request,
      );
    },
  };
}
test("portable restore observes lost chunk/native acknowledgements and persisted completion", async (t) => {
  const f = await setup(t);
  f.configure({ loseChunk: true, loseFinish: true });
  assert.deepEqual(await f.run(), {
    memoryPreserved: true,
    fallbackReason: null,
  });
  assert.equal(f.finishes(), 1);
  const calls = f.calls.length;
  f.reopen();
  assert.deepEqual(await f.run(), {
    memoryPreserved: true,
    fallbackReason: null,
  });
  assert.equal(f.calls.length, calls);
  await f.registry().retire(fence, "save");
});
test("uncertain native restore retains reader across controller restart and never repeats effect", async (t) => {
  const f = await setup(t);
  f.configure({ uncertain: true, loseFinish: true });
  await assert.rejects(f.run(), /lost native ACK/);
  assert.equal(f.finishes(), 1);
  await assert.rejects(f.registry().retire(fence, "save"), /protected/);
  f.reopen();
  await assert.rejects(f.run(), /uncertain/);
  assert.equal(f.finishes(), 1);
  f.observeRestored();
  assert.equal((await f.run()).memoryPreserved, true);
  await f.registry().retire(fence, "save");
});
test("unsupported runtime uses verified filesystem without attempting native import", async (t) => {
  const f = await setup(t);
  f.configure({ supported: false });
  assert.deepEqual(await f.run(), {
    memoryPreserved: false,
    fallbackReason: "runtime-unsupported",
  });
  assert(!f.calls.includes("memory-import-begin"));
  assert.equal(f.finishes(), 0);
});
test("incompatible target admits explicit fallback only after host abort", async (t) => {
  const f = await setup(t);
  f.configure({ rejected: true });
  assert.deepEqual(await f.run(), {
    memoryPreserved: false,
    fallbackReason: "memory-unavailable",
  });
  assert(f.calls.includes("memory-import-abort"));
  assert.equal(f.finishes(), 0);
});
test("missing memory bytes cannot enter native restore and require explicit fallback", async (t) => {
  const f = await setup(t);
  await f.store.delete(memoryObject);
  assert.deepEqual(await f.run(), {
    memoryPreserved: false,
    fallbackReason: "memory-object-missing",
  });
  assert(f.calls.includes("memory-import-abort"));
  assert.equal(f.finishes(), 0);
});

test("fresh memory objects omit redundant status calls and retain durable verified completion", async (t) => {
  const f = await setup(t);
  assert.equal((await f.run()).memoryPreserved, true);
  assert.equal(f.objectStatuses(), 0);
  assert.deepEqual(await f.progress(), { memory: "complete" });
});

for (const legacy of [false, true])
  test(`restart observes an uncertain object write instead of replaying bytes; legacy=${legacy}`, async (t) => {
    const f = await setup(t);
    f.configure({ loseChunk: true, failObjectStatus: true });
    await assert.rejects(f.run(), /status connection lost/);
    assert.equal(f.finishes(), 0);
    assert.deepEqual(await f.progress(), { memory: "started" });
    await assert.rejects(f.registry().retire(fence, "save"), /protected/);
    if (legacy) await f.legacyJournal();
    f.reopen();
    assert.equal((await f.run()).memoryPreserved, true);
    assert.equal(f.finishes(), 1);
    assert.equal(
      f.calls.filter((action) => action === "memory-import-chunk").length,
      1,
    );
    assert.equal(
      f.objectStatuses(),
      2,
      "failed observation plus restart observation",
    );
  });

test("parallel restore admits independent writes together and drains all before native execution", {
  timeout: 5000,
}, async (t) => {
  const f = await setup(t, 2, 2);
  let entered = 0;
  let ready!: () => void, release!: () => void;
  const both = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.beforeChunk(async () => {
    if (++entered === 2) ready();
    await gate;
  });
  const work = f.run();
  await both;
  assert.equal(f.finishes(), 0);
  assert.equal(f.objectStatuses(), 0);
  await assert.rejects(f.registry().retire(fence, "save"), /protected/);
  release();
  assert.equal((await work).memoryPreserved, true);
  assert.deepEqual(await f.progress(), {
    memory: "complete",
    "memory-1": "complete",
  });
});

test("a failed parallel write waits for other in-flight writes and resumes only the uncertain object", {
  timeout: 5000,
}, async (t) => {
  const f = await setup(t, 2, 2);
  let release!: () => void, ready!: () => void;
  const waiting = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.beforeChunk(async (id) => {
    if (id === "memory") throw Error("chunk transport lost");
    ready();
    await gate;
  });
  let settled = false;
  const work = f.run();
  void work
    .finally(() => {
      settled = true;
    })
    .catch(() => {});
  await waiting;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(f.finishes(), 0);
  release();
  await assert.rejects(work, /chunk transport lost/);
  assert.deepEqual(await f.progress(), {
    memory: "started",
    "memory-1": "complete",
  });
  f.beforeChunk(async () => {});
  f.reopen();
  assert.equal((await f.run()).memoryPreserved, true);
  assert.equal(
    f.objectStatuses(),
    2,
    "failure observation plus uncertain-object restart observation",
  );
  assert.equal(
    f.calls.filter((action) => action === "memory-import-chunk").length,
    3,
  );
});
