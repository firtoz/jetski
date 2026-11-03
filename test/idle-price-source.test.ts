import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { HostProvider, StateStore } from "../src/core/contracts.js";
import type {
  HostLifecycle,
  IdlePriceSource,
} from "../src/core/host-lifecycle.js";
import { SandboxManager } from "../src/core/manager.js";
import { PoolJournal } from "../src/core/pool.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

const policy: HostLifecycle = {
  lifetimeMs: 28_800_000,
  drainMs: 300_000,
  idle: {
    mode: "adaptive",
    minMs: 120_000,
    maxMs: 3_600_000,
    fallbackMs: 600_000,
    maxIdleSpendMicros: 18_000,
  },
};
const provider: HostProvider = {
  capabilities: () => ({
    kind: "machine-host",
    architecture: "x86_64",
    rootlessPodman: true,
    maxLifetimeMs: 86_400_000,
  }),
  allocate: async () => {
    throw Error("no allocation expected");
  },
  inspect: async () => ({ state: "unknown" }),
  retire: async () => {
    throw Error("no retirement expected");
  },
};
const make = (state: StateStore, source: IdlePriceSource, now: () => number) =>
  new SandboxManager(
    state,
    provider,
    {
      request: async () => {
        throw Error("no host contact expected");
      },
    },
    new LocalCheckpointStore("/unused-price-fixture"),
    {
      poolId: "pool",
      approvedImages: [],
      hostLifecycle: policy,
      idlePriceSource: source,
      now,
    },
  );
const quote = (now: number) => ({
  observedAt: now,
  validUntil: now + 300_000,
  computeMicrosPerHour: 18_000,
  avoidedStartMicros: 0,
  remainingIdleBudgetMicros: 18_000,
});

test("concurrent controllers share a durable quote refresh and restart reuses it", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  let now = 1000,
    calls = 0;
  const source: IdlePriceSource = {
    quote: async (input) => {
      calls++;
      return quote(input.now);
    },
  };
  const first = make(state, source, () => now),
    second = make(state, source, () => now);
  const results = await Promise.all([
    first.refreshIdlePrices("alice"),
    second.refreshIdlePrices("alice"),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(calls, 1);
  assert.equal(
    await make(state, source, () => now).refreshIdlePrices("alice"),
    false,
  );
  now += 300_001;
  assert.equal(await second.refreshIdlePrices("alice"), true);
  assert.equal(calls, 2);
});

test("pricing failure backs off durably and never blocks ordinary reconciliation", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  let now = 1000,
    calls = 0;
  const source: IdlePriceSource = {
    quote: async () => {
      calls++;
      throw Error("offline");
    },
  };
  await make(state, source, () => now).reconcile("alice");
  assert.equal(
    await make(state, source, () => now).refreshIdlePrices("alice"),
    false,
  );
  assert.equal(calls, 1);
  now += 30_001;
  await make(state, source, () => now).reconcile("alice");
  assert.equal(calls, 2);
});

test("late pricing completion cannot overwrite a replacement refresh", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  let now = 1000;
  const first = new PoolJournal(
    state,
    "pool",
    () => now,
    randomUUID,
    1,
    policy,
  );
  const old = (await first.claimIdlePriceRefresh("alice"))!;
  now += 30_001;
  const next = (await first.claimIdlePriceRefresh("alice"))!;
  assert.notEqual(next, old);
  assert.equal(
    await first.finishIdlePriceRefresh("alice", next, quote(now)),
    true,
  );
  assert.equal(
    await first.finishIdlePriceRefresh("alice", old, {
      ...quote(now),
      avoidedStartMicros: 70_000,
    }),
    false,
  );
  assert.equal(await first.claimIdlePriceRefresh("alice"), undefined);
});
