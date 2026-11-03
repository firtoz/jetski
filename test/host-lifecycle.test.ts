import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideIdleRetention,
  type HostLifecycle,
  hostLifecycle,
  type IdlePriceQuote,
} from "../src/core/host-lifecycle.js";

const minute = 60_000;
const now = 1_000_000;
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
const quote: IdlePriceQuote = {
  observedAt: now,
  validUntil: now + 5 * minute,
  computeMicrosPerHour: 18_000,
  avoidedStartMicros: 70_000,
  remainingIdleBudgetMicros: 18_000,
};
const input = () => ({
  policy,
  idleSince: now,
  expiresAt: now + policy.lifetimeMs,
  returnGapsMs: [minute, minute, 25 * minute, 40 * minute],
  quote,
});

test("idle economics include cold misses and distinguish free from paid starts", () => {
  const paid = decideIdleRetention(input());
  assert.equal(paid.retireAt, now + 40 * minute);
  assert.equal(paid.reservedIdleCostMicros, 12_000);
  const free = decideIdleRetention({
    ...input(),
    quote: { ...quote, avoidedStartMicros: 0 },
  });
  assert.equal(free.retireAt, now + 2 * minute);
  assert.equal(free.reservedIdleCostMicros, 600);
  assert.deepEqual(input().returnGapsMs, [
    minute,
    minute,
    25 * minute,
    40 * minute,
  ]);
});

test("expired quotes and clock-ahead observations use a bounded absolute fallback", () => {
  for (const selected of [
    undefined,
    { ...quote, validUntil: now },
    { ...quote, observedAt: now + 1 },
  ]) {
    const decision = decideIdleRetention({ ...input(), quote: selected });
    assert.equal(decision.reason, "fallback");
    assert.equal(decision.retireAt, now + 10 * minute);
  }
  assert.deepEqual(
    decideIdleRetention(input()),
    decideIdleRetention(input()),
    "replay has no clock/network dependency",
  );
});

test("hard budgets and original host expiry override predicted reuse and latency floors", () => {
  const exhausted = decideIdleRetention({
    ...input(),
    quote: { ...quote, remainingIdleBudgetMicros: 10 },
  });
  assert.equal(exhausted.reason, "budget");
  assert.equal(exhausted.retireAt, now);
  const oldHost = decideIdleRetention({
    ...input(),
    expiresAt: now + 15 * minute,
    returnGapsMs: [10 * minute, 10 * minute, 40 * minute],
  });
  assert.equal(
    oldHost.retireAt,
    now + 10 * minute,
    "a new eight-hour policy cannot extend an existing host",
  );
  const draining = decideIdleRetention({
    ...input(),
    expiresAt: now + 4 * minute,
  });
  assert.equal(draining.reason, "drain");
  assert.equal(draining.retireAt, now);
});

test("configuration rejects unbounded spending while fixed defaults retain existing semantics", () => {
  assert.equal(hostLifecycle().lifetimeMs, 60 * minute);
  assert.deepEqual(hostLifecycle().idle, {
    mode: "fixed",
    timeoutMs: 10 * minute,
  });
  assert.throws(
    () => hostLifecycle({ ...policy, lifetimeMs: 31 * 24 * 60 * minute }),
    /lifetime/,
  );
  assert.throws(
    () => hostLifecycle({ ...policy, drainMs: policy.lifetimeMs }),
    /drain/,
  );
  assert.throws(
    () =>
      decideIdleRetention({
        ...input(),
        quote: { ...quote, computeMicrosPerHour: Number.NaN },
      }),
    /computeMicrosPerHour/,
  );
  const longAbsence = decideIdleRetention({
    ...input(),
    returnGapsMs: [7 * 24 * 60 * minute, 8 * 24 * 60 * minute],
  });
  assert.equal(
    longAbsence.retireAt,
    now + 2 * minute,
    "infrequent owners remain valid without expensive retention",
  );
});
