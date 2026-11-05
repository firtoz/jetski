import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SandboxManager } from "../src/core/manager.js";
import { serverConfig } from "../src/server/config.js";
import { acquireControllerLock } from "../src/server/controller-lock.js";
import { ServiceHealth } from "../src/server/health.js";
import {
  bearerAuthentication,
  createHttpServer,
  startWorker,
} from "../src/server/http.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

const image = "example/linux@sha256:" + "a".repeat(64);
const config = {
  dataDirectory: "/tmp/example",
  poolId: "example",
  approvedImages: [image],
  principals: [{ owner: "alice", tokenEnv: "TOKEN" }],
  hostProvider: { kind: "boat", tokenEnv: "BOAT_TOKEN" },
};
test("configuration fails closed on typo, unpinned image, unsafe adapter and conflicting listeners", () => {
  assert.equal(serverConfig(config).poolId, "example");
  for (const bad of [
    { ...config, automaticCollecton: true },
    { ...config, approvedImages: ["linux:latest"] },
    { ...config, principals: [{ owner: "alice", tokenEnv: "token-secret" }] },
    { ...config, hostProvider: { ...config.hostProvider, netwokMode: "none" } },
    { ...config, hostLifecycle: { lifetimeMs: 0 } },
    { ...config, sshGateway: { port: 8788 } },
    { ...config, storage: { kind: "s3", endpoint: "http://example" } },
  ])
    assert.throws(() => serverConfig(bad));
});
test("controller exclusion, ownership and manual crash-lock recovery", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jetski-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const release = await acquireControllerLock(dir);
  await assert.rejects(acquireControllerLock(dir));
  await release();
  await release();
  const again = await acquireControllerLock(dir);
  const path = join(dir, "controller.lock", "owner.json"),
    receipt = await readFile(path, "utf8");
  await writeFile(path, "changed");
  await assert.rejects(again());
  await writeFile(path, receipt);
  await again();
});
test("authenticated owner-scoped readiness, stale scheduler and transactional admission replay", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jetski-release-"));
  const state = new SqliteState(join(dir, "state.sqlite"));
  let allocations = 0,
    at = 1000;
  const manager = new SandboxManager(
    state,
    {
      capabilities: () => ({
        kind: "machine-host",
        architecture: "x86_64",
        rootlessPodman: true,
      }),
      allocate: async () => {
        allocations++;
        throw Error("not expected");
      },
      inspect: async () => ({ state: "unknown" }),
      retire: async () => {},
    },
    {
      request: async () => {
        throw Error("not expected");
      },
    },
    new LocalCheckpointStore(join(dir, "objects")),
    { poolId: "test", approvedImages: [image], maxSandboxesPerOwner: 1 },
  );
  const health = new ServiceHealth(() => at);
  const server = createHttpServer(
    manager,
    bearerAuthentication([
      { owner: "alice", token: "a".repeat(32) },
      { owner: "bob", token: "b".repeat(32) },
    ]),
    { health: () => health.snapshot() },
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/v1/health`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    state.close();
    await rm(dir, { recursive: true, force: true });
  });
  assert.equal((await fetch(url)).status, 401);
  const headers = { authorization: "Bearer " + "a".repeat(32) };
  assert.equal((await fetch(url, { headers })).status, 503);
  health.succeeded();
  const id = randomUUID(),
    op = randomUUID();
  await manager.create("alice", id, image, op);
  await manager.create("alice", id, image, op);
  await assert.rejects(
    manager.create("alice", randomUUID(), image, randomUUID()),
    /bound/,
  );
  assert.equal(
    (await manager.pendingOperations({ owner: "alice", sandbox: id }))
      .operations.length,
    1,
  );
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).sandboxes, { queued: 1 });
  assert.deepEqual(
    (
      await (
        await fetch(url, {
          headers: { authorization: "Bearer " + "b".repeat(32) },
        })
      ).json()
    ).sandboxes,
    {},
  );
  assert.equal(allocations, 0);
  at += 30001;
  assert.equal((await fetch(url, { headers })).status, 503);
  health.succeeded();
  health.failed();
  assert.equal(health.snapshot().ready, false);
  at++;
  health.succeeded();
  assert.equal(health.snapshot().ready, true);
  health.stop();
  assert.equal((await fetch(url, { headers })).status, 503);
});
test("state backup/reopen retains exact metadata and unknown newer format refuses mutation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jetski-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");
  const state = new SqliteState(path);
  await state.transaction((tx) =>
    tx.put("fixture", { value: "hello 😀", generation: 42 }),
  );
  state.close();
  const db = new DatabaseSync(path),
    backup = join(dir, "backup.sqlite");
  db.prepare("VACUUM INTO ?").run(backup);
  db.close();
  const restored = new SqliteState(backup);
  assert.deepEqual(await restored.transaction((tx) => tx.get("fixture")), {
    value: "hello 😀",
    generation: 42,
  });
  restored.close();
  const future = new DatabaseSync(path);
  future.exec("PRAGMA user_version=2");
  future.close();
  assert.throws(() => new SqliteState(path), /Unsupported/);
  const check = new DatabaseSync(path);
  assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 2);
  check.close();
});
test("scheduler reports a failed cycle without concealing per-owner errors", async () => {
  let completed: (value: boolean) => void = () => {},
    cycles = 0;
  const cycle = new Promise<boolean>((resolve) => {
    completed = resolve;
  });
  const stop = startWorker(
    {
      owners: async () => ["a", "b"],
      reconcile: async (owner: string) => {
        if (owner === "a") throw Error("failed");
      },
      maintain: async () => {
        cycles++;
      },
    } as unknown as SandboxManager,
    () => {},
    5,
    completed,
  );
  assert.equal(await cycle, false);
  await stop();
  assert.equal(cycles, 1);
});

test("actual CLI controller stops and restarts without provider activity or stale lock", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jetski-controller-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "server.json");
  const c = {
    ...config,
    dataDirectory: join(dir, "data"),
    port: 18789,
    hostProvider: {
      kind: "ssh",
      hosts: [
        {
          id: "fixture",
          hostname: "127.0.0.1",
          port: 9,
          user: "fixture",
          privateKeyPath: "/unavailable",
          knownHostsPath: "/unavailable",
        },
      ],
    },
  };
  await writeFile(configPath, JSON.stringify(c));
  const start = async () => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "serve", "--config", configPath],
      {
        env: { ...process.env, TOKEN: "a".repeat(32) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    t.after(() => child.kill("SIGKILL"));
    let output = "",
      errors = "";
    child.stderr.on("data", (b) => {
      errors += b;
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(Error("No listener: " + errors));
      }, 10000);
      child.stdout.on("data", (b) => {
        output += b;
        if (output.includes("listening")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(Error("Early controller exit: " + errors));
      });
    });
    return child;
  };
  let child = await start();
  assert.throws(() =>
    execFileSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "serve", "--config", configPath],
      {
        env: { ...process.env, TOKEN: "a".repeat(32) },
        stdio: "pipe",
        timeout: 5000,
      },
    ),
  );
  let exit = once(child, "exit");
  child.kill("SIGTERM");
  assert.deepEqual(await exit, [0, null]);
  child = await start();
  exit = once(child, "exit");
  child.kill("SIGTERM");
  assert.deepEqual(await exit, [0, null]);
});
