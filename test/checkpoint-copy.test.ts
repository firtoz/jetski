import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  CheckpointCopy,
  checkpointCopyBatchObjects,
} from "../src/core/checkpoint-copy.js";
import { CheckpointRegistry } from "../src/core/checkpoints.js";
import { type CheckpointStore, DEFAULTS } from "../src/core/contracts.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

test("bounded checkpoint copy survives upload and publication ACK loss, then survives source collection", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-copy-"));
  const path = join(directory, "state.sqlite");
  let state = new SqliteState(path),
    now = Date.now();
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const objects = new LocalCheckpointStore(join(directory, "objects"));
  let loseUpload = true,
    losePublication = true,
    writes = 0;
  const storage: CheckpointStore = {
    head: (key) => objects.head(key),
    read: (key, range) => objects.read(key, range),
    list: (scope) => objects.list(scope),
    delete: (key) => objects.delete(key),
    put: async (key, source, expected) => {
      writes++;
      const result = await objects.put(key, source, expected);
      if (loseUpload) {
        loseUpload = false;
        throw Error("upload ACK lost");
      }
      return result;
    },
  };
  const registry = () => new CheckpointRegistry(state, objects, () => now);
  const source = { owner: "alice", sandbox: "source", generation: 1 },
    target = { ...source, sandbox: "target" };
  const plain = [
      Buffer.from("binary\0\xff"),
      Buffer.from("Unicode λ — bytes\n"),
    ],
    compressed = plain.map((bytes) => gzipSync(bytes));
  let offset = 0;
  const metadata = {
    version: 1,
    sha256: sha(Buffer.concat(compressed)),
    bytes: compressed.reduce((n, b) => n + b.length, 0),
    expandedBytes: plain.reduce((n, b) => n + b.length, 0),
    entries: 2,
    frames: compressed.map((b, i) => {
      const frame = {
        offset,
        bytes: b.length,
        expandedBytes: plain[i]!.length,
        sha256: sha(b),
        expandedSha256: sha(plain[i]!),
      };
      offset += b.length;
      return frame;
    }),
  };
  await registry().initialize(source);
  await registry().admit(source, "save", "writer");
  const frames = [];
  for (const [i, bytes] of compressed.entries())
    frames.push(
      await objects.put(
        { owner: source.owner, sandbox: source.sandbox, id: `source-${i}` },
        (async function* () {
          yield bytes;
        })(),
        { bytes: bytes.length, sha256: sha(bytes) },
      ),
    );
  await registry().publish(source, "save", "root", frames, metadata);
  const id = randomUUID();
  const copier = () => {
    const r = registry(),
      publish = r.publish.bind(r);
    r.publish = async (...args) => {
      await publish(...args);
      if (losePublication) {
        losePublication = false;
        throw Error("publication ACK lost");
      }
    };
    return new CheckpointCopy(state, r, storage);
  };
  await assert.rejects(
    copier().start(source, { ...target, owner: "bob" }, id, "root"),
    /same-owner/,
  );
  const admitted = await copier().start(source, target, id, "root");
  assert.deepEqual(await copier().start(source, target, id, "root"), admitted);
  await assert.rejects(registry().retire(source, "root"), /protected/);
  await assert.rejects(registry().collect(target, "gc"), /Active/);
  await assert.rejects(copier().advance(target, id, 1), /upload ACK lost/);
  state.close();
  state = new SqliteState(path);
  assert.equal((await copier().advance(target, id, 1)).next, 1);
  assert.equal(
    writes,
    1,
    "lost upload acknowledgement reuses verified object identity",
  );
  await assert.rejects(copier().advance(target, id, 1), /publication ACK lost/);
  state.close();
  state = new SqliteState(path);
  const done = await copier().advance(target, id, 1);
  assert.equal(done.phase, "published");
  assert.equal(writes, 2);
  await registry().retire(source, "root");
  now += DEFAULTS.gcGraceMs + 1;
  assert.equal((await registry().collect(source, "collect")).deleted, 2);
  const root = await registry().root(target, id);
  assert.ok(root);
  assert.deepEqual(root.metadata, metadata);
  for (const [i, frame] of root.frames.entries()) {
    const chunks = [];
    for await (const chunk of objects.read(frame))
      chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), compressed[i]);
  }
  assert.equal((await copier().advance(target, id)).phase, "published");
  await assert.rejects(
    copier().start(source, target, id, "different"),
    /identity conflict/,
  );
  const retryTarget = { ...target, sandbox: "partial" },
    retryId = randomUUID();
  let brokenStream = true;
  const interrupted: CheckpointStore = {
    head: (key) => objects.head(key),
    put: (key, bytes, expected) => objects.put(key, bytes, expected),
    list: (scope) => objects.list(scope),
    delete: (key) => objects.delete(key),
    read: async function* (key, range) {
      if (brokenStream) {
        brokenStream = false;
        yield new Uint8Array([1]);
        throw Error("source stream interrupted");
      }
      yield* objects.read(key, range);
    },
  };
  const retryCopy = new CheckpointCopy(state, registry(), interrupted);
  await retryCopy.start(target, retryTarget, retryId, id);
  await assert.rejects(
    retryCopy.advance(retryTarget, retryId),
    /source stream interrupted/,
  );
  const failedIdentity = (await retryCopy.inspect(retryTarget, retryId))
    .frames[0]!.id;
  assert.equal(
    (await retryCopy.advance(retryTarget, retryId)).phase,
    "published",
  );
  assert.notEqual(
    (await retryCopy.inspect(retryTarget, retryId)).frames[0]!.id,
    failedIdentity,
  );
  const raced = { ...target, sandbox: "raced" },
    raceId = randomUUID();
  let releasePut: () => void = () => {},
    enteredPut: () => void = () => {};
  const putStarted = new Promise<void>((resolve) => {
    enteredPut = resolve;
  });
  const putAllowed = new Promise<void>((resolve) => {
    releasePut = resolve;
  });
  const delayed: CheckpointStore = {
    head: (key) => objects.head(key),
    read: (key, range) => objects.read(key, range),
    list: (scope) => objects.list(scope),
    delete: (key) => objects.delete(key),
    put: async (key, sourceBytes, expected) => {
      enteredPut();
      await putAllowed;
      return objects.put(key, sourceBytes, expected);
    },
  };
  const racingCopy = new CheckpointCopy(state, registry(), delayed);
  await racingCopy.start(target, raced, raceId, id);
  const pending = racingCopy.advance(raced, raceId, 1);
  await putStarted;
  await racingCopy.cancel(raced, raceId);
  assert.equal(
    (
      await new CheckpointCopy(state, registry(), objects).advance(
        raced,
        raceId,
      )
    ).phase,
    "cancelled",
  );
  releasePut();
  assert.equal((await pending).phase, "cancelled");
  assert.equal(await registry().root(raced, raceId), undefined);
  const cancelled = { ...target, sandbox: "cancelled" },
    cancelId = randomUUID();
  await new CheckpointCopy(state, registry(), objects).start(
    target,
    cancelled,
    cancelId,
    id,
  );
  const c = new CheckpointCopy(state, registry(), objects);
  assert.equal((await c.advance(cancelled, cancelId, 1)).next, 1);
  await c.cancel(cancelled, cancelId);
  assert.equal((await c.advance(cancelled, cancelId)).phase, "cancelled");
  assert.equal(await registry().root(cancelled, cancelId), undefined);
  assert.equal((await registry().collect(cancelled, "early")).deleted, 0);
  await assert.rejects(
    c.inspect({ ...cancelled, generation: 2 }, cancelId),
    /unavailable/,
  );
});

test("247-object copies reduce scheduler turns while preserving bytes across controller restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-copy-batch-"));
  const path = join(directory, "state.sqlite");
  let state = new SqliteState(path);
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const objects = new LocalCheckpointStore(join(directory, "objects"));
  const source = { owner: "owner", sandbox: "source", generation: 1 };
  const registry = () => new CheckpointRegistry(state, objects);
  await registry().initialize(source);
  await registry().admit(source, "save", "writer");
  const plain = Array.from({ length: 247 }, (_, i) =>
    Buffer.from(`frame ${i}: binary\0 Unicode λ\n`.repeat(128)),
  );
  const compressed = plain.map((bytes) => gzipSync(bytes));
  const frames = [];
  for (const [i, bytes] of compressed.entries()) {
    frames.push(
      await objects.put(
        { ...source, id: `frame-${i}` },
        (async function* () {
          yield bytes;
        })(),
        { bytes: bytes.length, sha256: sha(bytes) },
      ),
    );
  }
  let offset = 0;
  const metadata = {
    version: 1,
    sha256: sha(Buffer.concat(compressed)),
    bytes: compressed.reduce((n, b) => n + b.length, 0),
    expandedBytes: plain.reduce((n, b) => n + b.length, 0),
    entries: 247,
    frames: compressed.map((bytes, i) => {
      const result = {
        offset,
        bytes: bytes.length,
        expandedBytes: plain[i]!.length,
        sha256: sha(bytes),
        expandedSha256: sha(plain[i]!),
      };
      offset += bytes.length;
      return result;
    }),
  };
  await registry().publish(source, "save", "root", frames, metadata);
  for (const batch of [2, undefined, 256]) {
    const target = {
      ...source,
      sandbox: `batch-${batch ?? "default"}`,
    };
    const copier = () => new CheckpointCopy(state, registry(), objects);
    let record = await copier().start(source, target, "copy", "root");
    let turns = 0;
    const started = performance.now();
    while (record.phase === "copying") {
      record = await copier().advance(target, "copy", batch);
      turns++;
      if (turns === 4) {
        // A new controller resumes the durable cursor, not a fresh copy.
        state.close();
        state = new SqliteState(path);
        assert.deepEqual(await copier().inspect(target, "copy"), record);
        await assert.rejects(registry().retire(source, "root"), /protected/);
      }
      if (record.phase === "copying")
        assert.equal(await registry().root(target, "copy"), undefined);
    }
    const workMs = performance.now() - started;
    assert.equal(turns, Math.ceil(247 / (batch ?? 16)));
    const root = await registry().root(target, "copy");
    assert.ok(root);
    assert.deepEqual(root.metadata, metadata);
    for (const [i, frame] of root.frames.entries()) {
      const chunks = [];
      for await (const chunk of objects.read(frame))
        chunks.push(Buffer.from(chunk));
      assert.deepEqual(Buffer.concat(chunks), compressed[i]);
    }
    t.diagnostic(
      JSON.stringify({
        batch: batch ?? "default",
        objects: 247,
        turns,
        workMs,
        modeledIdleMsAtOneSecondCadence: (turns - 1) * 1000,
      }),
    );
  }
});

test("copy batch bounds reject unbounded work", () => {
  assert.equal(checkpointCopyBatchObjects(), 16);
  assert.equal(checkpointCopyBatchObjects(256), 256);
  for (const value of [0, -1, 257, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(() => checkpointCopyBatchObjects(value), /batch bound/);
});
