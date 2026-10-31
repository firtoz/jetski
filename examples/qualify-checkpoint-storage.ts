/** Disposable frame/publication qualification; no execution host is allocated.
 * GC uses a synthetic clock in this fresh fixture scope, never a production clock.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  CheckpointRegistry,
  type CheckpointStore,
  CheckpointTransfer,
  DEFAULTS,
  type ObjectAddress,
} from "../src/core/index.js";
import type { CapturedArchive } from "../src/core/transfer.js";
import {
  type StorageConfig,
  standaloneStorage,
} from "../src/server/storage.js";
import { SqliteState } from "../src/state/sqlite.js";

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const directory = await mkdtemp(
  join(tmpdir(), "jetski-checkpoint-qualification-"),
);
const fence = {
  owner: `qualification-${randomUUID()}`,
  sandbox: "checkpoint",
  generation: 1,
};
const addresses: ObjectAddress[] = [];
const checks: string[] = [];
let state = new SqliteState(join(directory, "state.sqlite"));
let session: Awaited<ReturnType<typeof standaloneStorage>> | undefined;
let passed = false;
let cleanup = false;
let phase = "configuration";
let now = Date.now();
let puts = 0;
let losePut = true;
let loseDelete = false;
let config: StorageConfig = { kind: "local" };
const started = Date.now();
function wrapped(): CheckpointStore {
  const base = session!.store;
  return {
    head: (address) => base.head(address),
    read: (address, range) => base.read(address, range),
    list: (scope) => base.list(scope),
    put: async (address, stream, info) => {
      assert.equal(address.owner, fence.owner);
      assert.equal(address.sandbox, fence.sandbox);
      assert.ok(addresses.length < 4, "Fixture object bound");
      addresses.push(address);
      puts++;
      const result = await base.put(address, stream, info);
      if (losePut) {
        losePut = false;
        throw Error("Injected committed upload acknowledgement loss");
      }
      return result;
    },
    delete: async (address) => {
      assert.ok(
        addresses.some(
          (item) =>
            item.id === address.id &&
            item.owner === address.owner &&
            item.sandbox === address.sandbox,
        ),
      );
      await base.delete(address);
      if (loseDelete) {
        loseDelete = false;
        throw Error("Injected committed deletion acknowledgement loss");
      }
    },
  };
}
function archive(parts: Buffer[]) {
  const frames = parts.map((part) => gzipSync(part));
  const bytes = Buffer.concat(frames);
  let offset = 0;
  const manifest: CapturedArchive = {
    version: 1,
    sha256: sha(bytes),
    bytes: bytes.length,
    expandedBytes: parts.reduce((sum, part) => sum + part.length, 0),
    entries: 2,
    frames: frames.map((frame, index) => {
      const value = {
        offset,
        bytes: frame.length,
        expandedBytes: parts[index]!.length,
        sha256: sha(frame),
        expandedSha256: sha(parts[index]!),
      };
      offset += frame.length;
      return value;
    }),
  };
  return { bytes, manifest };
}
try {
  if (process.argv[2])
    config = JSON.parse(
      await readFile(process.argv[2], "utf8"),
    ) as StorageConfig;
  if (config.kind === "s3") config = { ...config, listPageSize: 1 };
  session = await standaloneStorage(directory, config);
  for await (const _ of session.store.list(fence))
    throw Error("Fixture scope not empty");
  let store = wrapped();
  let registry = new CheckpointRegistry(state, store, () => now);
  await registry.initialize(fence);
  const original = randomBytes(65539);
  const changed = randomBytes(32771);
  const first = archive([original]);
  const second = archive([original, changed]);
  phase = "upload-ack-loss";
  await assert.rejects(
    new CheckpointTransfer(store, registry).save(
      fence,
      "first",
      first.manifest,
      {
        read: async (offset, count) =>
          first.bytes.subarray(offset, offset + count),
      },
    ),
    /Injected committed upload/,
  );
  assert.equal(await registry.root(fence, "first"), undefined);
  await assert.rejects(registry.collect(fence, "writer-blocked"), /Active/);
  state.close();
  session.close();
  state = new SqliteState(join(directory, "state.sqlite"));
  session = await standaloneStorage(directory, config);
  store = wrapped();
  registry = new CheckpointRegistry(state, store, () => now);
  const absent = {
    read: async (): Promise<Uint8Array> => {
      throw Error("Source unavailable");
    },
  };
  const recovered = await new CheckpointTransfer(store, registry).save(
    fence,
    "first",
    first.manifest,
    absent,
  );
  assert.equal(puts, 1);
  assert.equal(recovered.uploadedBytes, 0);
  assert.equal(recovered.reusedBytes, first.bytes.length);
  checks.push(
    "committed-upload-ack-loss",
    "sqlite-and-storage-reopen",
    "source-independent-publication",
  );
  phase = "changed-frame-save";
  const saved = await new CheckpointTransfer(store, registry).save(
    fence,
    "second",
    second.manifest,
    {
      read: async (offset, count) => {
        assert.ok(
          offset >= first.bytes.length,
          "Unchanged frame must not be reread",
        );
        return second.bytes.subarray(offset, offset + count);
      },
    },
    "first",
  );
  assert.equal(puts, 2);
  assert.equal(saved.reusedBytes, first.bytes.length);
  assert.equal(saved.uploadedBytes, second.bytes.length - first.bytes.length);
  assert.equal(saved.root.frames[0]!.id, recovered.root.frames[0]!.id);
  const replay = await new CheckpointTransfer(store, registry).save(
    fence,
    "second",
    second.manifest,
    absent,
  );
  assert.equal(replay.uploadedBytes, 0);
  checks.push("changed-frame-only-upload", "stable-save-replay");
  phase = "retained-recovery";
  await registry.pin(fence, "second", "fixture", true);
  await assert.rejects(registry.retire(fence, "second"), /protected/);
  await registry.retire(fence, "first");
  now += DEFAULTS.gcGraceMs;
  assert.deepEqual(await registry.collect(fence, "shared"), { deleted: 0 });
  const restored: Buffer[] = [];
  for (const frame of saved.root.frames) {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of store.read(frame)) {
      bytes += chunk.length;
      assert.ok(bytes <= frame.bytes);
      chunks.push(chunk);
    }
    const compressed = Buffer.concat(chunks);
    assert.equal(sha(compressed), frame.sha256);
    restored.push(gunzipSync(compressed, { maxOutputLength: 65539 }));
  }
  assert.deepEqual(Buffer.concat(restored), Buffer.concat([original, changed]));
  await registry.admit(fence, "reader", "reader", "second");
  await assert.rejects(registry.collect(fence, "reader-blocked"), /Active/);
  await registry.close(fence, "reader");
  await registry.pin(fence, "second", "fixture", false);
  await registry.retire(fence, "second");
  assert.deepEqual(await registry.collect(fence, "early"), { deleted: 0 });
  checks.push(
    "pin-and-reader-protection",
    "retained-shared-frame",
    "exact-binary-reconstruction",
    "grace-refusal",
  );
  phase = "delete-ack-loss";
  now += DEFAULTS.gcGraceMs;
  loseDelete = true;
  await assert.rejects(
    registry.collect(fence, "retired"),
    /Injected committed deletion/,
  );
  state.close();
  session.close();
  state = new SqliteState(join(directory, "state.sqlite"));
  session = await standaloneStorage(directory, config);
  store = wrapped();
  registry = new CheckpointRegistry(state, store, () => now);
  assert.deepEqual(await registry.collect(fence, "retired"), { deleted: 2 });
  assert.deepEqual(await registry.collect(fence, "retired"), { deleted: 2 });
  for await (const _ of store.list(fence))
    throw Error("Unexpected remaining fixture object");
  checks.push("delete-ack-loss-reopen", "stable-collection-replay");
  passed = true;
  phase = "complete";
} catch {
  // Do not emit provider exceptions: they may contain request/credential context.
  process.exitCode = 1;
} finally {
  cleanup = session !== undefined;
  if (session) {
    for (const address of addresses) {
      try {
        // Explicit disposable fixture identities only; never delete discovered objects.
        await session.store.delete(address);
        assert.equal(await session.store.head(address), undefined);
      } catch {
        cleanup = false;
      }
    }
    session.close();
  }
  state.close();
  if (!cleanup) process.exitCode = 1;
  console.log(
    JSON.stringify({
      version: 1,
      backend: config.kind,
      passed: passed && cleanup,
      phase,
      ...fence,
      checks,
      puts,
      elapsedMs: Date.now() - started,
      syntheticGcClock: true,
      faultBoundary: "adapter-return",
      physicalHostRecovery: false,
      cleanup: {
        complete: cleanup,
        objects: addresses,
        reservationMarkersRetained: true,
      },
      retainedStateDirectory: passed && cleanup ? null : directory,
    }),
  );
  if (passed && cleanup) await rm(directory, { recursive: true, force: true });
}
