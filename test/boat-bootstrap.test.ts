import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  GVISOR_RUNTIME,
  validateRuntimePolicy,
} from "../src/core/runtime-policy.js";
import { BoatApi } from "../src/providers/boat.js";
import { BoatBootstrap } from "../src/providers/boat-bootstrap.js";
import {
  BOAT_BOOTSTRAP_MODULES,
  EmbeddedBoatBootstrap,
} from "../src/providers/boat-bootstrap-embedded.js";
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
        archiveTransferUser: "user",
        poolId: "pool",
        images: [image],
      });
      assert.deepEqual(
        Object.keys(bundle.files).sort(),
        [...BOAT_BOOTSTRAP_MODULES].sort(),
      );
      assert.ok(Object.hasOwn(bundle.files, "runtime_backend.py"));
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
  await assert.rejects(
    new BoatBootstrap(state, api, "pool", [image], "egress").ensure("bx_boot"),
    /identity changed/,
  );
  await assert.rejects(
    new BoatBootstrap(
      state,
      api,
      "pool",
      [image],
      "none",
      "fuse-overlayfs",
    ).ensure("bx_boot"),
    /identity changed/,
  );
  assert.throws(
    () =>
      new BoatBootstrap(
        state,
        api,
        "pool",
        [image],
        "none",
        "unknown" as never,
      ),
    /storage policy/,
  );
  assert.throws(
    () => new BoatBootstrap(state, api, "pool", [image], "host" as never),
    /network policy/,
  );
  await new BoatBootstrap(state, api, "pool", [image]).ensure("bx_boot");
  assert.equal(calls, completedCalls);
  const files: Record<string, Uint8Array> = {};
  for (const name of BOAT_BOOTSTRAP_MODULES) {
    files[name] = await readFile(
      new URL(
        `../host/${name.endsWith(".c") ? "native/" : ""}${name}`,
        import.meta.url,
      ),
    );
  }
  const installer = await readFile(
    new URL("../host/install_bundle.py", import.meta.url),
  );
  const embedded = new EmbeddedBoatBootstrap(
    state,
    api,
    "pool",
    [image],
    async () => ({ files, installer }),
  );
  // Identical build-time assets preserve the exact installed identity.
  await embedded.ensure("bx_boot");
  assert.equal(calls, completedCalls);
  files["control.py"] = Buffer.from("changed source");
  await embedded.ensure("bx_boot"); // frozen snapshot ignores later caller edits
  const changed = () =>
    new EmbeddedBoatBootstrap(state, api, "pool", [image], async () => ({
      files,
      installer,
    }));
  await assert.rejects(changed().ensure("bx_boot"), /identity changed/);
  delete files["control.py"];
  await assert.rejects(changed().ensure("bx_boot"), /module set mismatch/);
  files["unexpected.py"] = Buffer.from("unexpected source");
  await assert.rejects(changed().ensure("bx_boot"), /module set mismatch/);
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
  assert.equal(hosts.transport.memorySource, undefined);
  const fast = await standaloneHosts(
    state,
    { kind: "boat", tokenEnv: "BOAT_KEY", archiveReads: true },
    "pool",
    [image],
    { BOAT_KEY: "fixture" },
  );
  assert.equal(typeof fast.transport.memorySource, "function");
  assert.equal(typeof fast.transport.checkpointSource, "function");
  assert.equal(fast.transport.memoryImport, undefined);
  await assert.rejects(
    standaloneHosts(
      state,
      { kind: "boat", tokenEnv: "BOAT_KEY", archiveReads: "yes" as never },
      "pool",
      [image],
      { BOAT_KEY: "fixture" },
    ),
    /archive read policy/,
  );
});

test("optional gVisor policy rejects unsupported host/network combinations before effects", () => {
  const state = new SqliteState(":memory:");
  try {
    let calls = 0;
    const api = new BoatApi("fixture", async () => {
      calls++;
      throw Error("Unexpected network effect");
    });
    const assets = async () => {
      throw Error("Unexpected asset effect");
    };
    assert.throws(
      () =>
        new EmbeddedBoatBootstrap(
          state,
          api,
          "pool",
          [image],
          assets,
          "none",
          "default",
          { kind: "rust", sha256: "a".repeat(64) },
          GVISOR_RUNTIME,
        ),
      /Python host/,
    );
    assert.throws(
      () =>
        new EmbeddedBoatBootstrap(
          state,
          api,
          "pool",
          [image],
          assets,
          "egress",
          "default",
          undefined,
          GVISOR_RUNTIME,
        ),
      /qualified network policy/,
    );
    new EmbeddedBoatBootstrap(
      state,
      api,
      "pool",
      [image],
      assets,
      "none",
      "default",
      undefined,
      GVISOR_RUNTIME,
    );
    assert.throws(
      () =>
        validateRuntimePolicy({
          ...GVISOR_RUNTIME,
          release: "latest",
        } as never),
      /unpinned/,
    );
    assert.equal(calls, 0);
  } finally {
    state.close();
  }
});
