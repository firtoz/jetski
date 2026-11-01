/** Explicitly funded, resumable live qualification. Never run as a connectivity probe. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { HostProvider, Json } from "../src/core/contracts.js";
import { SandboxManager } from "../src/core/manager.js";
import { PoolJournal } from "../src/core/pool.js";
import type { BoatAllocation } from "../src/providers/boat.js";
import { type HostConfig, standaloneHosts } from "../src/server/hosts.js";
import {
  type StorageConfig,
  standaloneStorage,
} from "../src/server/storage.js";
import { SqliteState } from "../src/state/sqlite.js";

type Config = {
  image: string;
  hosts: Extract<HostConfig, { kind: "boat" }>;
  storage: StorageConfig;
};
type Plan = {
  version: 1;
  owner: string;
  sandbox: string;
  pool: string;
  config: Config;
};
const [mode, inputDirectory, configPath] = process.argv.slice(2);
if (!inputDirectory || !["prepare", "run"].includes(mode ?? ""))
  throw Error(
    "Usage: qualify-live-boat.ts prepare DIRECTORY CONFIG | run DIRECTORY",
  );
const directory = resolve(inputDirectory);
if (mode === "prepare") await mkdir(directory, { mode: 0o700 });
const stat = await lstat(directory);
if (
  !stat.isDirectory() ||
  stat.isSymbolicLink() ||
  stat.uid !== process.getuid?.() ||
  (stat.mode & 0o077) !== 0
)
  throw Error("Private owned qualification directory required");
const planPath = join(directory, "plan.json");
if (mode === "prepare") {
  if (!configPath) throw Error("Configuration required");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Config;
  if (
    config.hosts.kind !== "boat" ||
    !/^.+@sha256:[a-f0-9]{64}$/.test(config.image)
  )
    throw Error("Boat and approved digest image required");
  const plan: Plan = {
    version: 1,
    owner: `qualification-${randomUUID()}`,
    sandbox: randomUUID(),
    pool: randomUUID(),
    config,
  };
  await writeFile(planPath, JSON.stringify(plan), { mode: 0o600, flag: "wx" });
  console.log(
    JSON.stringify({ prepared: true, paidHostsStarted: 0, maxAllocations: 2 }),
  );
} else {
  if (process.env.JETSKI_PAID_QUALIFICATION_APPROVED !== "1")
    throw Error("Separate paid-host approval required before running");
  const plan = JSON.parse(await readFile(planPath, "utf8")) as Plan;
  assert.equal(plan.version, 1);
  assert.match(plan.owner, /^qualification-[a-f0-9-]{36}$/);
  const state = new SqliteState(join(directory, "state.sqlite"));
  const storage = await standaloneStorage(directory, plan.config.storage);
  const hosts = await standaloneHosts(state, plan.config.hosts, plan.pool, [
    plan.config.image,
  ]);
  const provider: HostProvider = {
    capabilities: () => hosts.provider.capabilities(),
    inspect: (id) => hosts.provider.inspect(id),
    retire: (id, allocationId) => hosts.provider.retire(id, allocationId),
    allocate: async (input) => {
      assert.equal(input.owner, plan.owner);
      await state.transaction((tx) => {
        const key = `qualification-allocation/${input.operationId}`;
        if (tx.get(key)) return;
        if (tx.scan("qualification-allocation/").length >= 2)
          throw Error("Two-host qualification allocation limit reached");
        tx.put(key, { expiresAt: input.expiresAt });
      });
      return hosts.provider.allocate(input);
    },
  };
  const manager = new SandboxManager(
    state,
    provider,
    hosts.transport,
    storage.store,
    {
      poolId: plan.pool,
      approvedImages: [plan.config.image],
      ...(hosts.streamTransport
        ? { streamTransport: hosts.streamTransport }
        : {}),
    },
  );
  const scope = { owner: plan.owner, sandbox: plan.sandbox };
  let phase = "initialization";
  async function observe(check: () => Promise<boolean>, timeoutMs = 900000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await manager.reconcile(plan.owner);
      const sandbox = await manager.get(scope);
      if (sandbox?.phase === "quarantined")
        throw Error(
          "Qualification quarantined; preserve source and inspect receipts",
        );
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw Error("Qualification observation deadline; resume same directory");
  }
  async function step(name: string, action: (id: string) => Promise<Json>) {
    phase = name;
    const row = await state.transaction((tx) => {
      const key = `qualification-step/${name}`;
      const prior = tx.get<{
        id: string;
        complete: boolean;
        result: Json;
        started: number;
      }>(key);
      if (prior) return prior;
      const created = {
        id: randomUUID(),
        complete: false,
        result: null,
        started: Date.now(),
      };
      tx.put(key, created);
      return created;
    });
    if (row.complete) return row.result;
    const result = await action(row.id);
    await state.transaction((tx) =>
      tx.put(`qualification-step/${name}`, {
        ...row,
        complete: true,
        result,
        elapsedMs: Date.now() - row.started,
      }),
    );
    console.log(
      JSON.stringify({
        phase: name,
        complete: true,
        elapsedMs: Date.now() - row.started,
      }),
    );
    return result;
  }
  async function command(id: string, script: string): Promise<string> {
    await manager.startCommand(scope, id, ["/bin/sh", "-ec", script]);
    await observe(async () => {
      const status = (await manager.commandStatus(scope, id)) as {
        phase: string;
        exitCode: number | null;
      };
      if (["failed", "cancelled", "uncertain"].includes(status.phase))
        throw Error(
          "Fixture command did not succeed; never replay with a new ID",
        );
      if (status.phase !== "succeeded") return false;
      assert.equal(status.exitCode, 0);
      return true;
    }, 180000);
    const output = (await manager.commandOutput(
      scope,
      id,
      "stdout",
      0,
      262144,
    )) as { base64: string; nextOffset: number; terminal: boolean };
    assert.equal(output.terminal, true);
    return Buffer.from(output.base64, "base64").toString("utf8");
  }
  const oracle = `cd /workspace; sha256sum binary run.sh .git/config /home/sandbox/identity; stat -c '%a %s %n' binary run.sh empty .git/config; stat -c '%a %n' directory; test "$(stat -c %i binary)" = "$(stat -c %i hard)"; test "$(stat -c %h binary)" = 2; test "$(readlink link)" = binary; test "$(readlink dangling)" = missing; find . /home/sandbox -mindepth 1 -print | sort`;
  async function stopped(id: string) {
    await manager.stop(scope, id);
    await observe(async () => (await manager.get(scope))?.phase === "stopped");
    const sandbox = await manager.get(scope);
    assert.ok(sandbox?.checkpoint && !sandbox.lease);
    return sandbox.checkpoint;
  }
  async function resumed(id: string) {
    await manager.resume(scope, id);
    await observe(async () => (await manager.get(scope))?.phase === "running");
    const sandbox = await manager.get(scope);
    assert.ok(sandbox?.lease);
    return sandbox.lease.machineId;
  }
  async function drain() {
    const pool = new PoolJournal(state, plan.pool);
    await observe(async () =>
      (await pool.inspect(plan.owner)).every(
        (slot) => slot.phase === "retired",
      ),
    );
    const allocations = await state.transaction((tx) =>
      tx
        .scan<BoatAllocation>(`boat-allocation/${plan.owner}/`)
        .map((row) => row.value),
    );
    assert.ok(
      allocations.length > 0 && allocations.every((row) => row.retired),
    );
    return allocations.map((row) => row.id);
  }
  try {
    const first = await step("create", async (id) => {
      await manager.create(plan.owner, plan.sandbox, plan.config.image, id);
      await observe(
        async () => (await manager.get(scope))?.phase === "running",
      );
      return (await manager.get(scope))!.lease!.machineId;
    });
    await step("seed", (id) =>
      command(
        id,
        "cd /workspace; dd if=/dev/urandom of=binary bs=1048576 count=5 2>/dev/null; chmod 640 binary; ln binary hard; printf home > /home/sandbox/identity; ln -s binary link; ln -s missing dangling; mkdir directory .git; chmod 751 directory; printf '#!/bin/sh\\nexit 0\\n' > run.sh; chmod 755 run.sh; : > empty; printf '[core]\\n bare = false\\n' > .git/config",
      ),
    );
    const before = await step("oracle-initial", (id) => command(id, oracle));
    await step("save-initial", stopped);
    const warm = await step("resume-warm", resumed);
    assert.equal(warm, first);
    assert.equal(
      await step("verify-warm", (id) => command(id, oracle)),
      before,
    );
    await step("modify", (id) =>
      command(
        id,
        "printf '\\000changed\\377' >> /workspace/run.sh; chmod 750 /workspace/directory",
      ),
    );
    const changed = await step("oracle-changed", (id) => command(id, oracle));
    assert.notEqual(changed, before);
    await step("save-changed", stopped);
    await step("retire-source-real-idle", drain);
    const replacement = await step("resume-replacement", resumed);
    assert.notEqual(replacement, first);
    assert.equal(
      await step("verify-replacement", (id) => command(id, oracle)),
      changed,
    );
    await step("save-final", stopped);
    await step("retire-replacement-real-idle", drain);
    await step("cleanup-owned-objects", async () => {
      const objects = [];
      for await (const object of storage.store.list(scope)) {
        assert.equal(object.owner, scope.owner);
        assert.equal(object.sandbox, scope.sandbox);
        objects.push(object);
        if (objects.length > 1000) throw Error("Owned cleanup bound exceeded");
      }
      for (const object of objects) await storage.store.delete(object);
      return objects.length;
    });
    await writeFile(
      join(directory, "result.json"),
      JSON.stringify({
        passed: true,
        physicalReplacement: true,
        sameHostWarmReuse: true,
        exactFixtureOracle: true,
        cleanupComplete: true,
      }),
      { mode: 0o600 },
    );
    console.log(JSON.stringify({ passed: true, cleanupComplete: true }));
  } catch {
    console.log(
      JSON.stringify({
        passed: false,
        phase,
        statePreserved: true,
        automaticRetry: false,
      }),
    );
    process.exitCode = 1;
  } finally {
    storage.close();
    state.close();
  }
}
