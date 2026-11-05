import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { HostLifecycle } from "../src/core/host-lifecycle.js";
import { PoolJournal } from "../src/core/pool.js";
import { SqliteState } from "../src/state/sqlite.js";

const minute = 60_000;
const policy: HostLifecycle = {
  lifetimeMs: 8 * 60 * minute,
  drainMs: 5 * minute,
  idle: {
    mode: "adaptive",
    minMs: 2 * minute,
    maxMs: 60 * minute,
    fallbackMs: 10 * minute,
    maxIdleSpendMicros: 18_000,
  },
};
async function assigned(pool: PoolJournal) {
  await pool.enqueue("alice", randomUUID(), randomUUID(), null);
  const slot = (await pool.reserve("alice"))!;
  await pool.provisioned(slot.id, "alice", "host", slot.allocationId);
  const assignment = (await pool.assign("alice"))!;
  await pool.transition(assignment.lease, "active");
  return assignment;
}

test("persisted long leases survive restart and admit work beyond the original hour", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  let now = 1000;
  const pool = new PoolJournal(state, "pool", () => now, randomUUID, 1, policy);
  const assignment = await assigned(pool);
  assert.equal(assignment.slot.expiresAt, now + 8 * 60 * minute);
  now += 61 * minute;
  const restarted = new PoolJournal(state, "pool", () => now);
  await state.transaction((tx) =>
    restarted.admitExecutionIn(tx, assignment.lease, 60),
  );
  await restarted.transition(assignment.lease, "quiescing");
  await restarted.release(assignment.lease);
  await restarted.enqueue("alice", randomUUID(), randomUUID(), null);
  const next = (await restarted.assign("alice"))!;
  assert.equal(next.lease.machineId, assignment.lease.machineId);
  assert.equal(next.slot.expiresAt, assignment.slot.expiresAt);
  assert.equal(next.lease.generation, 2);
});

test("an admitted idle deadline survives restart, pricing changes and competing demand", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  let now = 1000;
  const pool = new PoolJournal(state, "pool", () => now, randomUUID, 1, policy);
  const first = await assigned(pool);
  await pool.setIdlePriceQuote("alice", {
    observedAt: now,
    validUntil: now + 5 * minute,
    computeMicrosPerHour: 18_000,
    avoidedStartMicros: 0,
    remainingIdleBudgetMicros: 18_000,
  });
  await pool.transition(first.lease, "quiescing");
  await pool.release(first.lease);
  const idle = (await pool.inspect("alice"))[0]!;
  assert.equal(pool.idleRetireAt(idle), now + 2 * minute);
  const restarted = new PoolJournal(state, "pool", () => now, randomUUID, 1, {
    ...policy,
    idle: { mode: "fixed", timeoutMs: 60 * minute },
  });
  now += minute;
  await restarted.setIdlePriceQuote("alice", {
    observedAt: now,
    validUntil: now + 5 * minute,
    computeMicrosPerHour: 18_000,
    avoidedStartMicros: 70_000,
    remainingIdleBudgetMicros: 18_000,
  });
  assert.equal(
    restarted.idleRetireAt((await restarted.inspect("alice"))[0]!),
    idle.idleDecision!.retireAt,
  );
  now += 2 * minute;
  await restarted.enqueue("alice", randomUUID(), randomUUID(), null);
  assert.equal(
    (await restarted.retireIdle(idle.id)).phase,
    "idle",
    "queued demand wins over soft idle retirement",
  );
  const next = (await restarted.assign("alice"))!;
  assert.equal(next.lease.generation, 2);
  await assert.rejects(restarted.retireMissingIdle(idle), /stale/);
  await assert.rejects(restarted.retireIdle(idle.id), /not idle/);
});

test("legacy idle records retain original fixed semantics under a new operator policy", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  let now = 1000;
  const old = new PoolJournal(state, "pool", () => now);
  const first = await assigned(old);
  await old.transition(first.lease, "quiescing");
  await old.release(first.lease);
  const slot = (await old.inspect("alice"))[0]!;
  await state.transaction((tx) => {
    const { lifecycle, idleDecision, ...legacy } = slot;
    tx.put(`pool/pool/slot/${slot.id}`, legacy);
  });
  const next = new PoolJournal(state, "pool", () => now, randomUUID, 1, policy);
  const legacy = (await next.inspect("alice"))[0]!;
  assert.equal(next.idleRetireAt(legacy), now + 10 * minute);
  assert.equal(next.drainAt(legacy), first.slot.expiresAt - 5 * minute);
  now += 10 * minute;
  assert.equal((await next.retireIdle(slot.id)).phase, "quarantined");
});

test("native sleep admission survives restart, blocks assignment and fences stale power receipts", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  let now = 1000;
  const lifecycle: HostLifecycle = {
    lifetimeMs: 3600000,
    drainMs: 60000,
    idle: { mode: "fixed", timeoutMs: 600000 },
    nativeIdle: { mode: "disk", afterMs: 1000 },
  };
  const pool = new PoolJournal(
    state,
    "pool",
    () => now,
    randomUUID,
    1,
    lifecycle,
  );
  const first = await assigned(pool);
  assert.equal(
    await pool.claimNativePower(first.slot, false),
    undefined,
    "active workload must never sleep",
  );
  await pool.transition(first.lease, "quiescing");
  await pool.release(first.lease);
  let idle = (await pool.inspect("alice"))[0]!;
  assert.equal(
    await pool.claimNativePower(idle, false),
    undefined,
    "respect delay",
  );
  now += 1000;
  const pending = (await pool.claimNativePower(idle, false))!;
  assert.equal(pending.nativePower?.phase, "sleeping");
  const restarted = new PoolJournal(
    state,
    "pool",
    () => now,
    randomUUID,
    1,
    lifecycle,
  );
  await restarted.enqueue("alice", randomUUID(), randomUUID(), null);
  assert.equal(await restarted.assign("alice"), undefined);
  assert.equal(
    await restarted.reserve("alice"),
    undefined,
    "pending power consumes existing capacity",
  );
  await restarted.finishNativePower(pending);
  idle = (await restarted.inspect("alice"))[0]!;
  assert.equal(idle.nativePower?.phase, "asleep");
  const waking = (await restarted.claimNativePower(idle, true))!;
  await assert.rejects(restarted.finishNativePower(pending), /fenced/);
  assert.equal(await restarted.assign("alice"), undefined);
  await restarted.finishNativePower(waking);
  const second = (await restarted.assign("alice"))!;
  assert.equal(second.lease.machineId, first.lease.machineId);
  assert.equal(second.lease.generation, first.lease.generation + 1);
});
