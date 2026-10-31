import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalCheckpointStore } from "../src/storage/local.js";
import {
  qualifyStorage,
  StorageConformanceError,
} from "../src/testing/storage.js";

test("local store passes shared adapter contract through fresh instances", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jetski-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let instances = 0;
  const report = await qualifyStorage(async () => {
    instances++;
    return { store: new LocalCheckpointStore(root), close: () => {} };
  });
  assert.equal(instances, 2);
  assert.equal(report.checks.length, 12);
  assert.equal(report.cleanup.complete, true);
});

test("conformance records a failed invariant and cleans only owned fixture data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jetski-bad-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let cleaned = 0;
  await assert.rejects(
    qualifyStorage(async () => {
      const store = new LocalCheckpointStore(root);
      store.read = async function* () {
        yield Buffer.from("wrong");
      };
      const remove = store.delete.bind(store);
      store.delete = async (address) => {
        assert.ok(
          address.owner.startsWith("qualification-") ||
            address.owner.startsWith("foreign-"),
        );
        cleaned++;
        await remove(address);
      };
      return { store, close: () => {} };
    }),
    (error: unknown) => {
      assert.ok(error instanceof StorageConformanceError);
      assert.equal(error.report.phase, "bytes-and-isolation");
      assert.equal(error.report.passed, false);
      assert.equal(error.report.cleanup.complete, true);
      return true;
    },
  );
  assert.equal(cleaned, 3);
});

test("cleanup failure fails qualification but still attempts every fixture deletion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jetski-cleanup-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let deletes = 0;
  await assert.rejects(
    qualifyStorage(async () => {
      const store = new LocalCheckpointStore(root),
        remove = store.delete.bind(store);
      store.delete = async (address) => {
        deletes++;
        if (address.id === "empty") throw Error("Injected delete failure");
        await remove(address);
      };
      return { store, close: () => {} };
    }),
    (error: unknown) => {
      assert.ok(error instanceof StorageConformanceError);
      assert.equal(error.report.phase, "cleanup");
      assert.equal(error.report.cleanup.complete, false);
      assert.equal(error.report.cleanup.objectsAttempted, 6);
      assert.deepEqual(
        error.report.cleanup.failedObjects.map((address) => address.id),
        ["empty"],
      );
      return true;
    },
  );
  assert.equal(deletes, 8);
});
