import assert from "node:assert/strict";
import test from "node:test";
import type { HostFactory } from "../src/core/composition.js";
import { GVISOR_RUNTIME } from "../src/core/runtime-policy.js";
import { BoatApi } from "../src/providers/boat.js";
import { boatHostFactory } from "../src/providers/boat-hosts.js";
import { SqliteState } from "../src/state/sqlite.js";

test("generic Boat composition injects state/assets and never allocates or weakens policy during composition", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  let calls = 0,
    loads = 0;
  const api = new BoatApi("private-credential", async () => {
    calls++;
    throw Error("provider unavailable");
  });
  const loadAssets = async () => {
    loads++;
    throw Error("fixture asset boundary");
  };
  const factory = boatHostFactory(api, {
    id: "namespace",
    archiveWrites: true,
    checkpointUploadConcurrency: 2,
    loadAssets,
    maxIdleSpendMicros: 1000,
    runtimeSelection: {
      preference: {
        mode: "gvisor-preferred",
        allowPodmanFallbackFor: ["workload-compatibility"],
      },
      workload: "excluded",
      portableMemory: false,
    },
  });
  const contract: HostFactory = factory;
  assert.equal(
    JSON.stringify(contract.configuration).includes("private-credential"),
    false,
  );
  const hosts = factory.create({
    state,
    poolId: "pool",
    approvedImages: ["example/linux@sha256:" + "a".repeat(64)],
  });
  assert.equal(hosts.api, api);
  assert.equal(typeof hosts.transport.memoryImport, "function");
  assert.equal(hosts.streamTransport, undefined);
  assert.ok(hosts.idlePriceSource);
  assert.equal(await hosts.runtimeDecision("bx_owned"), null);
  assert.equal(calls, 0);
  assert.equal(loads, 0);
  await assert.rejects(hosts.provider.inspect("bx_foreign"), /not owned/);
  assert.equal(calls, 0);
  assert.throws(
    () =>
      boatHostFactory(api, {
        id: "namespace",
        loadAssets,
        runtime: GVISOR_RUNTIME,
        runtimeSelection: {
          preference: { mode: "gvisor-required" },
          workload: "qualified",
          portableMemory: true,
        },
      }),
    /fixed runtime or runtime selection/,
  );
});
