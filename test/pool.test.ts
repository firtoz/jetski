import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { DEFAULTS } from "../src/core/contracts.js";
import { PoolJournal } from "../src/core/pool.js";
import { SqliteState } from "../src/state/sqlite.js";

test("concurrent demand shares one allocation reservation and excess work queues", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  const first = new PoolJournal(state, "pool"),
    second = new PoolJournal(state, "pool");
  assert.equal(await first.reserve("alice"), undefined);
  await first.enqueue("alice", randomUUID(), "one", { image: "approved" });
  await second.enqueue("alice", randomUUID(), "two", { image: "approved" });
  const [a, b] = await Promise.all([
    first.reserve("alice"),
    second.reserve("alice"),
  ]);
  assert.ok(a);
  assert.deepEqual(a, b);
  await first.provisioned(a.id, "alice", "host", a.allocationId);
  const assigned = await first.assign("alice");
  assert.ok(assigned);
  assert.equal(assigned.ticket.id, "one");
  assert.equal(await second.assign("alice"), undefined);
  assert.equal(await second.reserve("alice"), undefined);
  await first.transition(assigned.lease, "active");
  await first.transition(assigned.lease, "quiescing");
  await first.release(assigned.lease);
  const next = await second.assign("alice");
  assert.ok(next);
  assert.equal(next.ticket.id, "two");
  assert.equal(next.lease.generation, 2);
  assert.equal(next.lease.slotId, assigned.lease.slotId);
  await first.release(assigned.lease); // Lost release ACK cannot free the new assignment.
  await assert.rejects(
    first.transition(assigned.lease, "quarantined"),
    /Stale/,
  );
  assert.equal(
    (await first.inspect("alice"))[0]?.lease?.assignmentId,
    next.lease.assignmentId,
  );
});

test("retirement retains owner and generation across adopted-host reallocation", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  let now = 1;
  const pool = new PoolJournal(state, "pool", () => now);
  await pool.enqueue("alice", randomUUID(), "one", null);
  const slot = await pool.reserve("alice");
  assert.ok(slot);
  await pool.provisioned(slot.id, "alice", "host", slot.allocationId);
  const placement = await pool.assign("alice");
  assert.ok(placement);
  await pool.transition(placement.lease, "active");
  await pool.transition(placement.lease, "quiescing");
  await pool.release(placement.lease);
  await assert.rejects(pool.retireIdle(slot.id), /not elapsed/);
  now += DEFAULTS.idleMs;
  await pool.retireIdle(slot.id);
  await pool.retired(slot.id);
  await pool.enqueue("bob", randomUUID(), "foreign", null);
  const foreign = await pool.reserve("bob");
  assert.ok(foreign);
  await assert.rejects(
    pool.provisioned(foreign.id, "bob", "host", foreign.allocationId),
    /already bound/,
  );
  await pool.enqueue("alice", randomUUID(), "two", null);
  const next = await pool.reserve("alice");
  assert.ok(next);
  await pool.provisioned(next.id, "alice", "host", next.allocationId);
  const reused = await pool.assign("alice");
  assert.ok(reused);
  assert.equal(reused.lease.generation, 2);
  assert.equal(reused.lease.slotId, placement.lease.slotId);
});

test("quarantine consumes capacity and expired hosts cannot receive work", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  let now = 0;
  const pool = new PoolJournal(state, "pool", () => now);
  await pool.enqueue("alice", randomUUID(), "one", null);
  const slot = await pool.reserve("alice");
  assert.ok(slot);
  await pool.provisioned(slot.id, "alice", "host", slot.allocationId);
  now = DEFAULTS.hostLifetimeMs;
  assert.equal(await pool.assign("alice"), undefined);
  await pool.retireIdle(slot.id);
  await pool.retired(slot.id);
  const replacement = await pool.reserve("alice");
  assert.ok(replacement);
  await pool.provisioned(
    replacement.id,
    "alice",
    "new-host",
    replacement.allocationId,
  );
  const assignment = await pool.assign("alice");
  assert.ok(assignment);
  await pool.transition(assignment.lease, "quarantined");
  await pool.enqueue("alice", randomUUID(), "two", null);
  assert.equal(await pool.reserve("alice"), undefined);
  await assert.rejects(pool.release(assignment.lease), /quiescence/);
});

test("absence observations cannot retire an intervening assignment", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  const pool = new PoolJournal(state, "pool");
  await pool.enqueue("alice", randomUUID(), "one", null);
  const reserved = (await pool.reserve("alice"))!;
  const idle = await pool.provisioned(
    reserved.id,
    "alice",
    "host",
    reserved.allocationId,
  );
  assert.equal(await pool.assign("alice", undefined, new Set()), undefined);
  const assigned = await pool.assign("alice", undefined, new Set([idle.id]));
  assert.ok(assigned);
  await assert.rejects(pool.retireMissingIdle(idle), /stale/);
  assert.equal((await pool.inspect("alice"))[0]?.phase, "assigned");
  await pool.transition(assigned.lease, "active");
  await pool.transition(assigned.lease, "quiescing");
  await pool.release(assigned.lease);
  const current = (await pool.inspect("alice"))[0]!;
  await assert.rejects(
    pool.retireMissingIdle({ ...current, owner: "bob" }),
    /stale/,
  );
  await pool.retireMissingIdle(current);
  assert.equal((await pool.inspect("alice"))[0]?.phase, "quarantined");
});

test("operator shutdown retires early only after release and refuses queued work", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  const pool = new PoolJournal(state, "pool", () => 1);
  await pool.enqueue("alice", randomUUID(), "one", null);
  const slot = (await pool.reserve("alice"))!;
  await pool.provisioned(slot.id, "alice", "host", slot.allocationId);
  const placement = (await pool.assign("alice"))!;
  await assert.rejects(pool.retireIdle(slot.id, "shutdown"), /not idle/);
  await pool.transition(placement.lease, "active");
  await pool.transition(placement.lease, "quiescing");
  await pool.release(placement.lease);
  await assert.rejects(pool.retireIdle(slot.id), /not elapsed/);
  await pool.enqueue("alice", randomUUID(), "queued", null);
  await assert.rejects(pool.retireIdle(slot.id, "shutdown"), /Queued/);
  const next = (await pool.assign("alice"))!;
  await pool.transition(next.lease, "active");
  await pool.transition(next.lease, "quiescing");
  await pool.release(next.lease);
  assert.equal(
    (await pool.retireIdle(slot.id, "shutdown")).phase,
    "quarantined",
  );
});
