import assert from "node:assert/strict";
import { test } from "node:test";
import { BoatApi } from "../src/providers/boat.js";
import { BoatIdlePriceSource } from "../src/providers/boat-pricing.js";

test("Boat pricing scales host size and strips unrelated account data", async () => {
  let calls = 0;
  const api = new BoatApi("fixture", async (url, init) => {
    calls++;
    assert.equal(new URL(String(url)).pathname, "/api/v1/limits");
    assert.equal(init?.method, "GET");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer fixture",
    );
    return Response.json({
      nextStartDollars: 0.03,
      overagePrices: { vmHourDollars: 0.036 },
      wallet: { private: "account-only" },
    });
  });
  for (const [machine, rate] of [
    ["small", 18_000],
    ["default", 36_000],
    ["large", 72_000],
  ] as const) {
    const quote = await new BoatIdlePriceSource(api, machine, 18_000).quote({
      owner: "alice",
      now: 1000,
      signal: new AbortController().signal,
    });
    assert.deepEqual(quote, {
      currency: "USD",
      observedAt: 1000,
      validUntil: 301_000,
      computeMicrosPerHour: rate,
      avoidedStartMicros: 30_000,
      remainingIdleBudgetMicros: 18_000,
    });
    assert.ok(!JSON.stringify(quote).includes("account-only"));
  }
  assert.equal(calls, 3);
});

test("blocked starts produce no fabricated fee and malformed prices fail closed", async () => {
  const context = {
    owner: "alice",
    now: 1000,
    signal: new AbortController().signal,
  };
  const blocked = new BoatIdlePriceSource(
    new BoatApi("fixture", async () =>
      Response.json({ nextStartDollars: null }),
    ),
    "small",
    18_000,
  );
  assert.equal(await blocked.quote(context), undefined);
  for (const value of [
    { nextStartDollars: -1, overagePrices: { vmHourDollars: 0.036 } },
    { nextStartDollars: 0, overagePrices: { vmHourDollars: -1 } },
    { nextStartDollars: 0, overagePrices: null },
  ]) {
    const source = new BoatIdlePriceSource(
      new BoatApi("fixture", async () => Response.json(value)),
      "small",
      18_000,
    );
    await assert.rejects(source.quote(context), /Invalid Boat idle pricing/);
  }
  let calls = 0;
  const api = new BoatApi("fixture", async () => {
    calls++;
    return Response.json({});
  });
  await assert.rejects(api.call("/limits", "POST", {}), /read-only/);
  assert.equal(calls, 0);
});
