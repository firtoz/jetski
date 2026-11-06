import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SandboxManager } from "../src/core/manager.js";
import { PoolJournal } from "../src/core/pool.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

test("one-shot preparations replay reservations, honor owner capacity and never replenish consumed hosts", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  let now = 1000;
  const pool = new PoolJournal(state, "pool", () => now, randomUUID, 3);
  const id = randomUUID();
  const first = await pool.prepare("owner", id, 3);
  assert.equal(await pool.nextMaintenanceAt("owner"), now + 1000);
  assert.deepEqual(await pool.prepare("owner", id, 3), first);
  await assert.rejects(pool.prepare("owner", id, 2), /identity conflict/);
  await assert.rejects(pool.prepare("owner", randomUUID(), 1), /capacity/);
  await assert.rejects(pool.preparation("other", id), /unavailable/);
  const one = await pool.reserveBatch("owner", 2);
  assert.equal(one.length, 2);
  assert.deepEqual(await pool.reserveBatch("owner", 2), one);
  const ready = new Set<string>();
  for (const slot of one) {
    assert.ok(await pool.dispatchAllocation(slot.id, "owner"));
    await pool.provisioned(slot.id, "owner", randomUUID(), slot.allocationId);
    ready.add(slot.id);
  }
  await pool.finishPreparations("owner", ready);
  assert.equal((await pool.preparation("owner", id)).phase, "pending");
  const last = (await pool.reserveBatch("owner", 2))[0]!;
  assert.ok(await pool.dispatchAllocation(last.id, "owner"));
  await pool.provisioned(last.id, "owner", randomUUID(), last.allocationId);
  ready.add(last.id);
  await pool.finishPreparations("owner", ready);
  assert.equal((await pool.preparation("owner", id)).machines.length, 3);
  assert.equal((await pool.preparation("owner", id)).phase, "ready");
  await pool.enqueue("owner", "sandbox", randomUUID(), null);
  const assignment = await pool.assign("owner", undefined, ready);
  assert.ok(assignment);
  assert.deepEqual(await pool.reserveBatch("owner", 2), []);
  assert.equal((await pool.prepare("owner", id, 3)).phase, "ready");
  assert.equal((await pool.inspect("other")).length, 0);
  now += 3600000;
  await pool.finishPreparations("owner", new Set());
  assert.equal(
    (await pool.preparation("owner", id)).phase,
    "ready",
    "completed outcome remains immutable",
  );
});

test("cancelled/expired preparation cannot dispatch a new allocation or bypass capacity", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  let now = 1000;
  const pool = new PoolJournal(state, "pool", () => now, randomUUID, 2);
  const request = await pool.prepare("owner", randomUUID(), 2);
  await pool.cancelPreparations("owner");
  assert.equal(
    (await pool.preparation("owner", request.id)).phase,
    "cancelled",
  );
  assert.ok(
    (await pool.inspect("owner")).every((slot) => slot.phase === "retired"),
  );
  const next = await pool.prepare("owner", randomUUID(), 2);
  now = next.expiresAt;
  for (const slot of await pool.reserveBatch("owner", 2))
    assert.equal(await pool.dispatchAllocation(slot.id, "owner"), undefined);
  await pool.finishPreparations("owner", new Set());
  assert.equal((await pool.preparation("owner", next.id)).phase, "expired");
});

test("approved image cache skips network on hit, verifies misses and fails closed on storage errors", () => {
  execFileSync(
    "python3",
    [
      "-c",
      `
import sys
sys.path.insert(0, 'host')
from bootstrap import ensure_approved_image
image='example/linux@sha256:'+'a'*64
for replies, expected, commands in [
 ([0], 'cached', ['image']),
 ([1,0,0], 'pulled', ['image','pull','image']),
 ([125], 'approved_image_cache_unavailable', ['image']),
 ([1,1], 'approved_image_pull_failed', ['image','pull']),
 ([1,0,1], 'approved_image_cache_unavailable', ['image','pull','image'])
]:
 calls=[]
 def run(args):
  calls.append(args)
  assert args[-1]==image
  return {'exitCode':replies.pop(0)}
 try:
  result=ensure_approved_image(run,image)
 except RuntimeError as error:
  result=str(error)
 assert result==expected,(result,expected)
 assert [args[0] for args in calls]==commands
 assert not replies
try:
 ensure_approved_image(lambda args: (_ for _ in ()).throw(Exception('unexpected execution')), 'linux:latest')
except ValueError:
 pass
else:
 raise AssertionError('mutable reference accepted')
`,
    ],
    { cwd: process.cwd(), stdio: "pipe" },
  );
});

test("slow preparation cannot report a host whose idle retention already elapsed as ready", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  let now = 1000;
  const pool = new PoolJournal(state, "pool", () => now, randomUUID, 1);
  const request = await pool.prepare("owner", randomUUID(), 1);
  const slot = (await pool.reserveBatch("owner", 1))[0]!;
  await pool.dispatchAllocation(slot.id, "owner");
  const idle = await pool.provisioned(
    slot.id,
    "owner",
    "machine",
    slot.allocationId,
  );
  now = pool.idleRetireAt(idle) + 1;
  assert.ok(now < request.expiresAt);
  await pool.finishPreparations("owner", new Set([slot.id]));
  assert.equal((await pool.preparation("owner", request.id)).phase, "pending");
  now = request.expiresAt;
  await pool.finishPreparations("owner", new Set([slot.id]));
  assert.equal((await pool.preparation("owner", request.id)).phase, "expired");
});

test("preparation spanning multiple startup batches rechecks already-idle hosts and finishes without synthetic workloads", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-prepare-waves-"));
  const state = new SqliteState(":memory:");
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  let allocations = 0;
  const hosts = new Set<string>();
  const manager = new SandboxManager(
    state,
    {
      capabilities: () => ({
        kind: "machine-host",
        architecture: "x86_64",
        rootlessPodman: true,
      }),
      allocate: async (input) => {
        const id = `host-${++allocations}`;
        hosts.add(id);
        return { id, allocationId: input.operationId };
      },
      inspect: async (id) => ({ state: hosts.has(id) ? "ready" : "absent" }),
      retire: async (id) => {
        hosts.delete(id);
      },
    },
    {
      request: async (_host, request) => ({
        version: 1,
        id: request.id,
        result: {},
      }),
    },
    new LocalCheckpointStore(directory),
    {
      poolId: "pool",
      approvedImages: ["example/linux@sha256:" + "a".repeat(64)],
      hostsPerOwner: 3,
      hostStartupConcurrency: 2,
    },
  );
  const id = randomUUID();
  await manager.prepareHosts("owner", id, 3);
  await manager.reconcile("owner");
  assert.equal(allocations, 2);
  assert.equal((await manager.hostPreparation("owner", id)).phase, "pending");
  await manager.reconcile("owner");
  assert.equal(allocations, 3);
  assert.equal((await manager.hostPreparation("owner", id)).phase, "ready");
  assert.equal((await manager.list("owner")).length, 0);
  await manager.reconcile("owner");
  assert.equal(allocations, 3);
  await manager.retireIdle("owner");
  assert.equal(hosts.size, 0);
});
