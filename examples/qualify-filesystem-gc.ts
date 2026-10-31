/** Resume only a private filesystem-store fixture after its real grace period. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, readFile, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  CheckpointRegistry,
  DEFAULTS,
  type Fence,
  type ObjectAddress,
  type ObjectInfo,
} from "../src/core/index.js";
import {
  type StorageConfig,
  standaloneStorage,
} from "../src/server/storage.js";
import { SqliteState } from "../src/state/sqlite.js";

assert.ok(process.argv[2], "Private retained fixture directory required");
const directory = resolve(process.argv[2]);
const meta = await lstat(directory);
assert.ok(
  meta.isDirectory() &&
    !meta.isSymbolicLink() &&
    meta.uid === process.getuid?.() &&
    (meta.mode & 0o077) === 0,
);
assert.match(basename(directory), /^jetski-filesystem-store-[A-Za-z0-9]+$/);
const record = JSON.parse(
  await readFile(join(directory, "real-grace.json"), "utf8"),
) as {
  version: number;
  fence: Fence;
  config: StorageConfig;
  addresses: ObjectAddress[];
  retiredFrames: ObjectInfo[];
  notBefore: number;
};
assert.equal(record.version, 1);
assert.match(record.fence.owner, /^qualification-[0-9a-f-]{36}$/);
assert.equal(record.fence.sandbox, "filesystem");
assert.equal(record.fence.generation, 1);
assert.ok(
  Number.isSafeInteger(record.notBefore) &&
    record.notBefore > DEFAULTS.gcGraceMs,
);
assert.ok(
  record.addresses.length > 0 &&
    record.addresses.length <= 32 &&
    record.retiredFrames.length > 0,
);
for (const address of [...record.addresses, ...record.retiredFrames]) {
  assert.equal(address.owner, record.fence.owner);
  assert.equal(address.sandbox, record.fence.sandbox);
  assert.match(address.id, /^[0-9a-f-]{36}$/);
}
const state = new SqliteState(join(directory, "state.sqlite"));
const session = await standaloneStorage(directory, record.config);
let passed = false,
  waiting = false,
  phase = "grace",
  deleted = 0;
try {
  const registry = new CheckpointRegistry(state, session.store);
  const root = await registry.root(record.fence, "version-2");
  assert.ok(root && root.pins.includes("fixture"));
  if (Date.now() < record.notBefore) {
    waiting = true;
  } else {
    phase = "collect";
    const result = await registry.collect(record.fence, "after-real-grace");
    assert.equal(result.deleted, record.retiredFrames.length);
    assert.deepEqual(
      await registry.collect(record.fence, "after-real-grace"),
      result,
    );
    deleted = result.deleted;
    for (const frame of record.retiredFrames)
      assert.equal(await session.store.head(frame), undefined);
    phase = "recover-retained-root";
    await rm(join(directory, "download-2.tgz"), { force: true });
    await rm(join(directory, "restored-2"), { recursive: true, force: true });
    const file = await open(join(directory, "download-2.tgz"), "wx", 0o600);
    try {
      for (const frame of root.frames) {
        const actual = await session.store.head(frame);
        assert.equal(actual?.sha256, frame.sha256);
        assert.equal(actual?.bytes, frame.bytes);
        const hash = createHash("sha256");
        let size = 0;
        for await (const part of session.store.read(frame)) {
          size += part.length;
          assert.ok(size <= frame.bytes);
          hash.update(part);
          let at = 0;
          while (at < part.length) {
            const wrote = await file.write(part.subarray(at));
            assert.ok(wrote.bytesWritten > 0);
            at += wrote.bytesWritten;
          }
        }
        assert.equal(size, frame.bytes);
        assert.equal(hash.digest("hex"), frame.sha256);
      }
      await file.sync();
    } finally {
      await file.close();
    }
    const restored = JSON.parse(
      (
        await promisify(execFile)(
          "python3",
          ["host/qualify_archive_store.py", "restore", directory, "2"],
          { timeout: 60000, maxBuffer: 8192 },
        )
      ).stdout,
    );
    assert.equal(restored.exact, true);
    phase = "cleanup";
    for (const address of record.addresses) {
      await session.store.delete(address);
      assert.equal(await session.store.head(address), undefined);
    }
    passed = true;
    phase = "complete";
  }
} catch {
  process.exitCode = 1;
} finally {
  session.close();
  state.close();
  console.log(
    JSON.stringify({
      version: 1,
      passed,
      waiting,
      phase,
      notBefore: record.notBefore,
      observedAt: Date.now(),
      deleted,
      realClock: true,
      sourceDeleted: true,
      physicalHostRecovery: false,
      retainedRootRecovered: passed,
      cleanup: { complete: passed, reservationMarkersRetained: true },
      retainedStateDirectory: passed ? null : directory,
    }),
  );
  if (passed) await rm(directory, { recursive: true, force: true });
}
