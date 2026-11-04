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
async function setup(t: { after: (f: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "jetski-memory-restore-"));
  let state = new SqliteState(join(dir, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(dir, { recursive: true, force: true });
  });
  const store = new LocalCheckpointStore(join(dir, "objects"));
  let registry = new CheckpointRegistry(state, store);
  await registry.initialize(fence);
  const root = fixture();
  await registry.admit(fence, "writer", "writer");
  for (const [object, bytes] of [
    [fsObject, fsBytes],
    [memoryObject, memoryBytes],
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
    offset = 0,
    finishes = 0,
    supported = true,
    loseChunk = false,
    loseFinish = false,
    uncertain = false,
    rejected = false;
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
        return {
          ...receipt(),
          ...(p.objectId
            ? {
                object: {
                  id: memoryObject.id,
                  offset,
                  complete: offset === memoryBytes.length,
                },
              }
            : {}),
        };
      case "memory-import-chunk": {
        const b = Buffer.from(String(p.base64), "base64");
        assert.deepEqual(b, memoryBytes);
        assert.equal(p.offset, offset);
        assert.equal(p.sha256, hash(b));
        offset += b.length;
        if (loseChunk) {
          loseChunk = false;
          throw Error("lost chunk ACK");
        }
        return { id: memoryObject.id, offset, complete: true };
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
    coordinator: () => new PortableMemoryRestore(state, registry, store),
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
    }) {
      supported = v.supported ?? supported;
      loseChunk = v.loseChunk ?? loseChunk;
      loseFinish = v.loseFinish ?? loseFinish;
      uncertain = v.uncertain ?? uncertain;
      rejected = v.rejected ?? rejected;
    },
    observeRestored() {
      phase = "restored";
    },
    finishes: () => finishes,
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
