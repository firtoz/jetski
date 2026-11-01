/** Real filesystem archives through local/S3 storage; no VM or workload starts. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  CheckpointRegistry,
  type CheckpointStore,
  CheckpointTransfer,
  DEFAULTS,
  type ObjectAddress,
  parseArchive,
} from "../src/core/index.js";
import { restoreCheckpoint } from "../src/core/restore.js";
import {
  type StorageConfig,
  standaloneStorage,
} from "../src/server/storage.js";
import { SqliteState } from "../src/state/sqlite.js";

const arguments_ = process.argv.slice(2);
const prepareGc = arguments_.includes("--prepare-gc"),
  packing = arguments_.includes("--packing");
const configArgs = arguments_.filter(
  (arg) => arg !== "--prepare-gc" && arg !== "--packing",
);
assert.ok(
  configArgs.length <= 1 && !configArgs.some((arg) => arg.startsWith("--")),
  "Invalid qualification arguments",
);
assert.ok(
  !(packing && prepareGc),
  "Timed fixture helper currently prepares legacy roots only",
);
const parent = prepareGc
  ? process.env.JETSKI_QUALIFICATION_STATE_DIRECTORY
  : tmpdir();
assert.ok(parent, "Persistent private state directory required for real grace");
if (prepareGc) {
  const meta = await lstat(parent);
  assert.ok(
    meta.isDirectory() &&
      !meta.isSymbolicLink() &&
      meta.uid === process.getuid?.() &&
      (meta.mode & 0o077) === 0,
  );
}
const directory = await mkdtemp(join(parent, "jetski-filesystem-store-"));
let retainForGrace = false;
let notBefore: number | undefined;
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
    verificationConcurrency: base.verificationConcurrency ?? 1,
    transferConcurrency: base.transferConcurrency ?? 1,
    ...(base.verifyRanges
      ? { verifyRanges: base.verifyRanges.bind(base) }
      : {}),
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
  if (configArgs[0])
    config = JSON.parse(await readFile(configArgs[0], "utf8")) as StorageConfig;
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
      const result = await new CheckpointTransfer(wrap(), registry, undefined, {
        packBytes: packing ? DEFAULTS.maxObjectBytes : 0,
      }).save(
        fence,
        `version-${version}`,
        manifest,
        {
          readConcurrency: 4,
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
    const manifest = JSON.parse(
      await readFile(join(directory, `manifest-${version}.json`), "utf8"),
    );
    const receipt = {
      id: `version-${version}`,
      sha256: manifest.sha256 as string,
      bytes: manifest.bytes as number,
      offset: 0,
      phase: "receiving",
    };
    try {
      await restoreCheckpoint(
        session.store,
        reopened,
        fence,
        receipt.id,
        async (action, payload) => {
          if (action === "import-begin") {
            const input = payload as {
              sha256: string;
              bytes: number;
              checkpointId: string;
            };
            assert.equal(input.sha256, receipt.sha256);
            assert.equal(input.bytes, receipt.bytes);
            assert.equal(input.checkpointId, receipt.id);
            return { ...receipt, chunkBytes: 512 * 1024 };
          }
          if (action === "import-chunk") {
            const part = payload as {
              offset: number;
              base64: string;
              sha256: string;
            };
            assert.equal(part.offset, receipt.offset);
            const bytes = Buffer.from(part.base64, "base64");
            assert.equal(
              createHash("sha256").update(bytes).digest("hex"),
              part.sha256,
            );
            let offset = 0;
            while (offset < bytes.length) {
              const wrote = await file.write(bytes.subarray(offset));
              assert.ok(wrote.bytesWritten > 0);
              offset += wrote.bytesWritten;
            }
            await file.sync();
            receipt.offset += bytes.length;
            return { ...receipt };
          }
          assert.equal(action, "import-finish");
          assert.equal(receipt.offset, receipt.bytes);
          await file.sync();
          receipt.phase = "ready";
          return { ...receipt };
        },
      );
    } finally {
      await file.close();
    }
    const result = await fixture("restore", directory, String(version));
    assert.equal(result.exact, true);
  }
  if (prepareGc) {
    const first = await reopened.root(fence, "version-1"),
      second = await reopened.root(fence, "version-2");
    assert.ok(first && second);
    const retiredFrames = first.frames.filter(
      (frame) => !second.frames.some((live) => live.id === frame.id),
    );
    assert.ok(retiredFrames.length > 0);
    await reopened.pin(fence, "version-1", "fixture", false);
    await reopened.retire(fence, "version-1");
    notBefore = Date.now() + DEFAULTS.gcGraceMs;
    assert.deepEqual(await reopened.collect(fence, "before-real-grace"), {
      deleted: 0,
    });
    for (const frame of first.frames)
      assert.ok(await session.store.head(frame));
    await writeFile(
      join(directory, "real-grace.json"),
      JSON.stringify({
        version: 1,
        fence,
        config,
        addresses,
        retiredFrames,
        notBefore,
      }),
      { flag: "wx", mode: 0o600 },
    );
    retainForGrace = true;
  }
  passed = true;
  phase = retainForGrace ? "waiting-real-grace" : "complete";
} catch {
  process.exitCode = 1;
} finally {
  cleanup = !!session;
  if (session) {
    for (const address of retainForGrace ? [] : addresses)
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
      packing,
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
      realGrace: { pending: retainForGrace, notBefore: notBefore ?? null },
      cleanup: {
        complete: cleanup && !retainForGrace,
        objects: addresses,
        reservationMarkersRetained: true,
      },
      retainedStateDirectory:
        passed && cleanup && !retainForGrace ? null : directory,
    }),
  );
  if (passed && cleanup && !retainForGrace)
    await rm(directory, { recursive: true, force: true });
  if (!passed || !cleanup) process.exitCode = 1;
}
