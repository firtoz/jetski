import assert from "node:assert/strict";
import { test } from "node:test";
import { BoatApi } from "../src/providers/boat.js";
import { BoatRuntimeEligibility } from "../src/providers/boat-runtime-selection.js";
import { SqliteState } from "../src/state/sqlite.js";

test("owned read-only preflight distinguishes eligibility, operator exclusion and uncertain evidence", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  await state.transaction((tx) => {
    tx.put("boat-host/bx_owned", "allocation");
    tx.put("allocation", { id: "bx_owned", retired: false });
  });
  let value: unknown = {
      version: 1,
      system: "Linux",
      machine: "x86_64",
      controllers: ["cpu", "memory", "pids"],
      maxUserNamespaces: 1000,
      namespaces: true,
    },
    calls = 0;
  const api = new BoatApi("private-fixture-token", async (_url, init) => {
    calls++;
    assert(!String(init?.body).includes("private-fixture-token"));
    return Response.json({
      success: true,
      exitCode: 0,
      timedOut: false,
      stdout: JSON.stringify(value),
      stderr: "",
    });
  });
  const qualified = new BoatRuntimeEligibility(state, api, "qualified");
  await assert.rejects(qualified.inspect("bx_foreign"), /actively owned/);
  assert.equal(calls, 0);
  assert.deepEqual(
    (await qualified.inspect("bx_owned")).map((v) => v.status),
    ["eligible", "eligible"],
  );
  const excluded = await new BoatRuntimeEligibility(
    state,
    api,
    "excluded",
  ).inspect("bx_owned");
  assert.equal(excluded[0]?.status, "unsupported");
  assert.equal(excluded[1]?.status, "eligible");
  value = { version: 1 };
  await assert.rejects(qualified.inspect("bx_owned"), /Unknown/);
  value = {
    version: 1,
    system: "Linux",
    machine: "x86_64",
    controllers: ["cpu"],
    maxUserNamespaces: 1000,
    namespaces: true,
  };
  assert(
    (await qualified.inspect("bx_owned")).every(
      (v) => v.status === "unsupported" && v.reason === "resource-enforcement",
    ),
  );
});
