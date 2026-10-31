/** Real filesystem archives through local/S3 storage; no VM or workload starts. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  CheckpointRegistry,
  type CheckpointStore,
  CheckpointTransfer,
  type ObjectAddress,
  parseArchive,
} from "../src/core/index.js";
import {
  type StorageConfig,
  standaloneStorage,
} from "../src/server/storage.js";
import { SqliteState } from "../src/state/sqlite.js";

const directory = await mkdtemp(join(tmpdir(), "jetski-filesystem-store-"));
const fence = {
  owner: `qualification-${randomUUID()}`,
  sandbox: "filesystem",
  generation: 1,
};
const addresses: ObjectAddress[] = [],
  measurements: unknown[] = [];
let state = new SqliteState(join(directory, "state.sqlite"));
let session: Awaited<ReturnType<typeof standaloneStorage>> | undefined;
let sourceDeleted = false;
let passed = false,
  cleanup = false,
  phase = "configuration";
let config: StorageConfig = { kind: "local" };
const started = Date.now();
const fixture = async (...args: string[]) =>
  JSON.parse(
    (
      await promisify(execFile)(
        "python3",
        ["host/qualify_archive_store.py", ...args],
        { timeout: 60000, maxBuffer: 8192 },
      )
    ).stdout,
  );
function wrap(): CheckpointStore {
  const base = session!.store;
  return {
    head: (address) => base.head(address),
    read: (address, range) => base.read(address, range),
    list: (scope) => base.list(scope),
    delete: (address) => base.delete(address),
    put: async (address, bytes, info) => {
      assert.equal(address.owner, fence.owner);
      assert.equal(address.sandbox, fence.sandbox);
      assert.ok(addresses.length < 32, "fixture object limit");
      addresses.push(address);
      return base.put(address, bytes, info);
    },
  };
}
try {
  if (process.argv[2])
    config = JSON.parse(
      await readFile(process.argv[2], "utf8"),
    ) as StorageConfig;
  session = await standaloneStorage(directory, config);
  for await (const _ of session.store.list(fence))
    throw Error("Fixture scope not empty");
  phase = "capture";
  assert.equal((await fixture("capture", directory)).sourceDeleted, true);
  sourceDeleted = true;
  const registry = new CheckpointRegistry(state, wrap());
  await registry.initialize(fence);
  for (const version of [1, 2]) {
    const manifest = parseArchive(
      JSON.parse(
        await readFile(join(directory, `manifest-${version}.json`), "utf8"),
      ),
    );
    const file = await open(join(directory, `archive-${version}.tgz`), "r");
    phase = `save-${version}`;
    const start = Date.now();
    try {
      const result = await new CheckpointTransfer(wrap(), registry).save(
        fence,
        `version-${version}`,
        manifest,
        {
          read: async (offset, bytes) => {
            const buffer = Buffer.alloc(bytes);
            const read = await file.read(buffer, 0, bytes, offset);
            assert.equal(read.bytesRead, bytes);
            return buffer;
          },
        },
        version === 2 ? "version-1" : undefined,
      );
      measurements.push({
        version,
        saveMs: Date.now() - start,
        archiveBytes: manifest.bytes,
        uploadedBytes: result.uploadedBytes,
        reusedBytes: result.reusedBytes,
      });
    } finally {
      await file.close();
    }
    await rm(join(directory, `archive-${version}.tgz`));
    await registry.pin(fence, `version-${version}`, "fixture", true);
  }
  state.close();
  session.close();
  state = new SqliteState(join(directory, "state.sqlite"));
  session = await standaloneStorage(directory, config);
  const reopened = new CheckpointRegistry(state, wrap());
  for (const version of [1, 2]) {
    phase = `restore-${version}`;
    const root = await reopened.root(fence, `version-${version}`);
    assert.ok(root);
    const file = await open(
      join(directory, `download-${version}.tgz`),
      "wx",
      0o600,
    );
    try {
      for (const frame of root.frames) {
        const hash = createHash("sha256");
        let size = 0;
        for await (const part of session.store.read(frame)) {
          size += part.length;
          assert.ok(size <= frame.bytes);
          hash.update(part);
          let offset = 0;
          while (offset < part.length) {
            const wrote = await file.write(part.subarray(offset));
            assert.ok(wrote.bytesWritten > 0);
            offset += wrote.bytesWritten;
          }
        }
        assert.equal(size, frame.bytes);
        assert.equal(hash.digest("hex"), frame.sha256);
      }
      await file.sync();
    } finally {
      await file.close();
    }
    const result = await fixture("restore", directory, String(version));
    assert.equal(result.exact, true);
  }
  passed = true;
  phase = "complete";
} catch {
  process.exitCode = 1;
} finally {
  cleanup = !!session;
  if (session) {
    for (const address of addresses)
      try {
        await session.store.delete(address);
        assert.equal(await session.store.head(address), undefined);
      } catch {
        cleanup = false;
      }
    session.close();
  }
  state.close();
  console.log(
    JSON.stringify({
      version: 1,
      backend: config.kind,
      passed: passed && cleanup,
      phase,
      ...fence,
      measurements,
      elapsedMs: Date.now() - started,
      sourceDeleted,
      physicalHostRecovery: false,
      checks: passed
        ? [
            "bytes",
            "modes",
            "symlinks",
            "hardlinks",
            "empty",
            "unicode",
            "rename",
            "delete",
            "opaque-dotgit",
            "historical-roots",
            "sqlite-storage-reopen",
          ]
        : [],
      cleanup: {
        complete: cleanup,
        objects: addresses,
        reservationMarkersRetained: true,
      },
      retainedStateDirectory: passed && cleanup ? null : directory,
    }),
  );
  if (passed && cleanup) await rm(directory, { recursive: true, force: true });
  else process.exitCode = 1;
}
