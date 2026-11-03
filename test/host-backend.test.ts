import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRustHostAssets } from "../src/host-rust-assets.js";
import { SqliteState } from "../src/state/sqlite.js";
import {
  bindHostBackend,
  hostControlArguments,
  hostControlCommand,
  validateHostBackend,
} from "../src/transport/host-backend.js";
import { sshArguments } from "../src/transport/ssh.js";

test("backend identity is immutable across controller reopen and forbids legacy conversion", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-backend-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let state = new SqliteState(join(directory, "state.sqlite"));
  const rust = { kind: "rust" as const, sha256: "a".repeat(64) };
  await bindHostBackend(state, "new", rust);
  state.close();
  state = new SqliteState(join(directory, "state.sqlite"));
  t.after(() => state.close());
  await bindHostBackend(state, "new", rust);
  await assert.rejects(
    bindHostBackend(state, "new", { kind: "python" }),
    /replacement/,
  );
  await assert.rejects(
    bindHostBackend(state, "new", { kind: "rust", sha256: "b".repeat(64) }),
    /replacement/,
  );
  await state.transaction((tx) =>
    tx.put("boat-bootstrap/old", { ready: true }),
  );
  await assert.rejects(
    bindHostBackend(state, "old", rust),
    /cannot be converted/,
  );
  await bindHostBackend(state, "old", { kind: "python" });
  await assert.rejects(bindHostBackend(state, "old", rust), /replacement/);
});
test("native dispatch directly selects the pinned binary and Python rejects a native intent", () => {
  const rust = { kind: "rust" as const, sha256: "a".repeat(64) };
  assert.deepEqual(hostControlArguments(rust), [
    "env",
    "-i",
    "PATH=/usr/bin:/bin",
    "/opt/jetski/native/jetski-host",
    "__control",
    rust.sha256,
  ]);
  assert.ok(!hostControlCommand(rust).includes("python"));
  assert.match(
    hostControlCommand(),
    /test ! -e \/var\/lib\/jetski-native\/intent.json/,
  );
  const args = sshArguments({
    id: "host",
    hostname: "example.test",
    user: "root",
    port: 22,
    privateKeyPath: "/key",
    knownHostsPath: "/hosts",
    backend: rust,
  });
  assert.equal(args.at(-1), hostControlCommand(rust));
  assert.throws(
    () => validateHostBackend({ kind: "rust", sha256: "not-a-digest" }),
    /Invalid/,
  );
});
test("native asset loader verifies exact bounded bytes without requiring a compiler", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-artifact-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "binary");
  const binary = Buffer.alloc(64, 17);
  await writeFile(path, binary);
  const sha = createHash("sha256").update(binary).digest("hex");
  const asset = await loadRustHostAssets(path, sha);
  assert.deepEqual(Buffer.from(asset.binary), binary);
  assert.ok(asset.installer.length > 0);
  await writeFile(path, Buffer.alloc(64, 18));
  await assert.rejects(loadRustHostAssets(path, sha), /integrity/);
});
