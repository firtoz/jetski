import assert from "node:assert/strict";
import test from "node:test";
import {
  decideIdleRetention,
  type HostLifecycle,
} from "../src/core/host-lifecycle.js";
import { GVISOR_RUNTIME } from "../src/core/runtime-policy.js";
import { machineRuntimeOptions } from "../src/providers/machine-options.js";
import { serverConfig } from "../src/server/config.js";

const image = `example.invalid/linux@sha256:${"a".repeat(64)}`;
function config() {
  return {
    dataDirectory: ".jetski",
    poolId: "pool",
    approvedImages: [image],
    principals: [{ owner: "alice", tokenEnv: "API_TOKEN" }],
    hostProvider: {
      kind: "boxd",
      namespace: "org-fra",
      region: "fra",
      tokenEnv: "BOXD_API_KEY",
      runtime: GVISOR_RUNTIME,
      networkMode: "public-egress",
      storageMode: "fuse-overlayfs",
    },
  };
}
test("boxd standalone configuration accepts shared pinned policy and rejects ambiguity before network effects", () => {
  assert.equal(serverConfig(config()).hostProvider.kind, "boxd");
  for (const patch of [
    { region: "" },
    { namespace: "" },
    { vcpu: 3 },
    { vcpu: 2, memory: "4G" },
    { baseURL: "http://boxd.sh:9443" },
    { baseURL: "https://boxd.sh:9443/" },
    { tokenEnv: "secret-value" },
    { typo: true },
    { networkMode: "private-magic" },
    { runtime: { kind: "gvisor" } },
    { runtime: GVISOR_RUNTIME, networkMode: "egress" },
  ]) {
    const c = config();
    assert.throws(() =>
      serverConfig({ ...c, hostProvider: { ...c.hostProvider, ...patch } }),
    );
  }
});
test("shared machine runtime policy snapshots mutable input and rejects unsupported gVisor networking", () => {
  const init = ["/workspace/app"];
  const policy = machineRuntimeOptions({
    runtime: GVISOR_RUNTIME,
    workloadInit: init,
    networkMode: "public-egress",
  });
  init.push("changed");
  assert.deepEqual(policy.workloadInit, ["/workspace/app"]);
  assert.throws(() =>
    machineRuntimeOptions({ runtime: GVISOR_RUNTIME, networkMode: "egress" }),
  );
});
test("adaptive idle never compares a EUR quote to a USD budget and preserves explicit EUR economics", () => {
  const policy: HostLifecycle = {
    lifetimeMs: 3600000,
    drainMs: 60000,
    idle: {
      mode: "adaptive",
      currency: "EUR",
      minMs: 1000,
      maxMs: 600000,
      fallbackMs: 60000,
      maxIdleSpendMicros: 10000,
    },
  };
  const quote = {
    currency: "EUR" as const,
    observedAt: 10000,
    validUntil: 20000,
    computeMicrosPerHour: 36000,
    avoidedStartMicros: 10000,
    remainingIdleBudgetMicros: 10000,
  };
  const input = {
    policy,
    idleSince: 10000,
    expiresAt: 3610000,
    returnGapsMs: [100000, 100000],
    quote,
  };
  assert.equal(decideIdleRetention(input).reason, "adaptive");
  assert.equal(
    decideIdleRetention({ ...input, quote: { ...quote, currency: "USD" } })
      .reason,
    "fallback",
  );
  if (policy.idle.mode !== "adaptive") throw Error("fixture policy");
  const { currency: _currency, ...oldQuote } = quote;
  const oldUSDPolicy: HostLifecycle = {
    ...policy,
    idle: { ...policy.idle, mode: "adaptive", currency: "USD" },
  };
  assert.equal(
    decideIdleRetention({
      ...input,
      policy: oldUSDPolicy,
      quote: oldQuote,
    }).reason,
    "adaptive",
  );
});

test("boxd idle quote uses explicit currency, bounded resources and actual rate units without a fake start fee", async () => {
  const { BoxdIdlePriceSource } = await import(
    "../src/providers/boxd-pricing.js"
  );
  const source = new BoxdIdlePriceSource(
    async () => ({
      currency: "eur",
      rates: {
        vcpuHourMicro: 39000,
        ramGibHourMicro: 12000,
        diskGibHourMicro: 80,
      },
    }),
    { vcpu: 2, memoryGiB: 8 },
    { currency: "EUR", maxIdleSpendMicros: 10000, diskGiB: 20 },
  );
  const context = {
    owner: "alice",
    now: 10000,
    signal: new AbortController().signal,
  };
  const quote = await source.quote(context);
  assert.equal(quote.computeMicrosPerHour, 175600);
  assert.equal(quote.currency, "EUR");
  assert.equal(quote.avoidedStartMicros, 0);
  const wrong = new BoxdIdlePriceSource(
    async () => ({
      currency: "usd",
      rates: { vcpuHourMicro: 1, ramGibHourMicro: 1, diskGibHourMicro: 1 },
    }),
    { vcpu: 2, memoryGiB: 8 },
    { currency: "EUR", maxIdleSpendMicros: 10000, diskGiB: 20 },
  );
  await assert.rejects(wrong.quote(context), /currency/);
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(source.quote({ ...context, signal: stopped.signal }));
});
