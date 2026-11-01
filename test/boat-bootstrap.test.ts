import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { BoatApi } from "../src/providers/boat.js";
import { BoatBootstrap } from "../src/providers/boat-bootstrap.js";
import { standaloneHosts } from "../src/server/hosts.js";
import { SqliteState } from "../src/state/sqlite.js";

const image = `example.invalid/image@sha256:${"a".repeat(64)}`;
test("Boat bootstrap journals code and policy, resumes uncertainty and rejects changed policy", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  await state.transaction((tx) => {
    tx.put("boat-host/bx_boot", "allocation");
    tx.put("allocation", { id: "bx_boot", retired: false });
  });
  let calls = 0,
    lose = true,
    sha = "";
  const api = new BoatApi("secret-test-credential", async (_url, init) => {
    calls++;
    assert.ok(!String(init?.body).includes("secret-test-credential"));
    const body = JSON.parse(String(init?.body));
    if (init?.method === "PUT") {
      const bytes = Buffer.from(body.content, "base64");
      const bundle = JSON.parse(bytes.toString());
      assert.deepEqual(bundle.config, {
        version: 1,
        machineId: "bx_boot",
        poolId: "pool",
        images: [image],
      });
      assert.equal(Object.keys(bundle.files).length, 20);
      assert.ok(Object.hasOwn(bundle.files, "streams.py"));
      assert.equal(
        Object.keys(bundle).sort().join(","),
        "config,files,version",
      );
      sha = createHash("sha256").update(bytes).digest("hex");
      return Response.json({
        success: true,
        path: body.path,
        size: bytes.length,
      });
    }
    const install = body.command.includes("bytes.fromhex");
    if (install && lose) {
      lose = false;
      throw Error("Injected response loss");
    }
    return Response.json({
      success: true,
      exitCode: 0,
      timedOut: false,
      stderr: "",
      stdout: install
        ? JSON.stringify({
            version: 1,
            digest: sha,
            machineId: "bx_boot",
            ready: true,
          })
        : "",
    });
  });
  await assert.rejects(
    new BoatBootstrap(state, api, "pool", [image]).ensure("bx_foreign"),
    /not actively owned/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    new BoatBootstrap(state, api, "pool", [image]).ensure("bx_boot"),
    /unknown/,
  );
  const pending = await state.transaction((tx) =>
    tx.get<{ ready: boolean }>("boat-bootstrap/bx_boot"),
  );
  assert.equal(pending?.ready, false);
  await new BoatBootstrap(state, api, "pool", [image]).ensure("bx_boot");
  const completedCalls = calls;
  await new BoatBootstrap(state, api, "pool", [image]).ensure("bx_boot");
  assert.equal(calls, completedCalls);
  await assert.rejects(
    new BoatBootstrap(state, api, "different", [image]).ensure("bx_boot"),
    /identity changed/,
  );
  assert.equal(calls, completedCalls);
});

test("standalone Boat selection requires explicit credentials and approved images without allocating", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  await assert.rejects(
    standaloneHosts(
      state,
      { kind: "boat", tokenEnv: "BOAT_KEY" },
      "pool",
      [image],
      {},
    ),
    /credential/,
  );
  await assert.rejects(
    standaloneHosts(
      state,
      { kind: "boat", tokenEnv: "BOAT_KEY" },
      "pool",
      ["image:latest"],
      { BOAT_KEY: "fixture" },
    ),
    /digest/,
  );
  const hosts = await standaloneHosts(
    state,
    { kind: "boat", tokenEnv: "BOAT_KEY" },
    "pool",
    [image],
    { BOAT_KEY: "fixture" },
  );
  assert.equal(hosts.provider.capabilities().kind, "machine-host");
});
