import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GVISOR_RUNTIME, PODMAN_RUNTIME } from "../src/core/runtime-policy.js";
import {
  bindRuntimeSelection,
  type RuntimeAdmission,
  type RuntimePreference,
  selectRuntime,
} from "../src/core/runtime-selection.js";
import {
  PreparingRuntimeBootstrap,
  SelectingRuntimeBootstrap,
} from "../src/providers/runtime-selection.js";
import { SqliteState } from "../src/state/sqlite.js";

const requirements = { networkMode: "none" as const, portableMemory: false };
const preference: RuntimePreference = {
  mode: "gvisor-preferred",
  allowPodmanFallbackFor: [
    "network-policy",
    "host-platform",
    "resource-enforcement",
  ],
};
const admissions = (): RuntimeAdmission[] => [
  {
    runtime: GVISOR_RUNTIME,
    evidenceId: "verified-gvisor-host",
    status: "supported",
    networkModes: ["none"],
    portableMemory: true,
  },
  {
    runtime: PODMAN_RUNTIME,
    evidenceId: "verified-podman-host",
    status: "supported",
    networkModes: ["none", "egress"],
    portableMemory: false,
  },
];
test("prefers checked gVisor; Podman-only remains independent of unknown gVisor support", () => {
  assert.equal(
    selectRuntime(preference, requirements, admissions()).runtime.kind,
    "gvisor",
  );
  const proof = admissions();
  proof[0] = {
    runtime: GVISOR_RUNTIME,
    evidenceId: "not-probed",
    status: "unknown",
  };
  assert.equal(
    selectRuntime({ mode: "podman-only" }, requirements, proof).runtime.kind,
    "podman",
  );
  assert.throws(
    () => selectRuntime(preference, requirements, proof),
    /uncertain/,
  );
});
test("known unsupported networking requires explicit fallback consent and a capable alternative", () => {
  const decision = selectRuntime(
    preference,
    { ...requirements, networkMode: "egress" },
    admissions(),
  );
  assert.equal(decision.runtime.kind, "podman");
  assert.equal(decision.fallbackReason, "network-policy");
  assert.throws(
    () =>
      selectRuntime(
        { mode: "gvisor-required" },
        { ...requirements, networkMode: "egress" },
        admissions(),
      ),
    /not permitted/,
  );
  assert.throws(
    () =>
      selectRuntime(
        { mode: "gvisor-preferred", allowPodmanFallbackFor: [] },
        { ...requirements, networkMode: "egress" },
        admissions(),
      ),
    /not permitted/,
  );
  const proof = admissions();
  proof[0] = {
    runtime: GVISOR_RUNTIME,
    evidenceId: "limits-failed",
    status: "unsupported",
    reason: "resource-enforcement",
  };
  assert.throws(
    () =>
      selectRuntime(
        preference,
        { ...requirements, portableMemory: true },
        proof,
      ),
    /cannot meet/,
  );
});
test("rejects invalid admission, missing evidence and unrecognized fallback reasons", () => {
  assert.throws(
    () => selectRuntime(preference, requirements, []),
    /Both runtime/,
  );
  const proof = admissions();
  proof[0] = { ...proof[0]!, evidenceId: "" };
  assert.throws(
    () => selectRuntime(preference, requirements, proof),
    /identifier/,
  );
  assert.throws(
    () =>
      selectRuntime(
        {
          mode: "gvisor-preferred",
          allowPodmanFallbackFor: ["timeout" as never],
        },
        requirements,
        admissions(),
      ),
    /fallback permission/,
  );
});
test("durably binds selection before effects; restart observes the same runtime and changed policy refuses reuse", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  const first = await bindRuntimeSelection(
    state,
    "physical-host",
    preference,
    requirements,
    admissions(),
  );
  const later = admissions();
  later[0] = {
    runtime: GVISOR_RUNTIME,
    evidenceId: "later-probe",
    status: "unsupported",
    reason: "host-platform",
  };
  assert.deepEqual(
    await bindRuntimeSelection(
      state,
      "physical-host",
      preference,
      requirements,
      later,
    ),
    first,
  );
  await assert.rejects(
    bindRuntimeSelection(
      state,
      "physical-host",
      { mode: "podman-only" },
      requirements,
      later,
    ),
    /replace host/,
  );
});

test("bootstrap failure propagates without trying a different runtime", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  const attempted: string[] = [];
  const bootstrap = new SelectingRuntimeBootstrap(
    state,
    preference,
    requirements,
    async () => admissions(),
    (runtime) => ({
      async ensure() {
        attempted.push(runtime.kind);
        throw Error("uncertain bootstrap");
      },
    }),
  );
  await assert.rejects(
    bootstrap.ensure("physical-host"),
    /uncertain bootstrap/,
  );
  assert.deepEqual(attempted, ["gvisor"]);
});

test("lost capability on a bound host refuses admission without rebinding", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  let facts = admissions();
  const attempted: string[] = [];
  const bootstrap = new SelectingRuntimeBootstrap(
    state,
    preference,
    requirements,
    async () => facts,
    (runtime) => ({
      async ensure() {
        attempted.push(runtime.kind);
      },
    }),
  );
  await bootstrap.ensure("physical-host");
  facts = admissions();
  facts[0] = {
    runtime: GVISOR_RUNTIME,
    evidenceId: "limits-no-longer-proven",
    status: "unsupported",
    reason: "resource-enforcement",
  };
  await assert.rejects(bootstrap.ensure("physical-host"), /not permitted/);
  assert.deepEqual(attempted, ["gvisor"]);
});

test("public egress needs explicit evidence on both preferred and fallback runtimes", () => {
  const required = { ...requirements, networkMode: "public-egress" as const };
  assert.throws(
    () => selectRuntime(preference, required, admissions()),
    /cannot meet/,
  );
  const proof = admissions();
  proof[0] = {
    runtime: GVISOR_RUNTIME,
    evidenceId: "verified-public-egress",
    status: "supported",
    networkModes: ["none", "public-egress"],
    portableMemory: true,
  };
  assert.equal(
    selectRuntime(preference, required, proof).runtime.kind,
    "gvisor",
  );
  proof[0] = {
    runtime: GVISOR_RUNTIME,
    evidenceId: "unsupported-public-egress",
    status: "unsupported",
    reason: "network-policy",
  };
  assert.throws(
    () => selectRuntime(preference, required, proof),
    /cannot meet/,
  );
  proof[1] = {
    runtime: PODMAN_RUNTIME,
    evidenceId: "verified-public-egress-podman",
    status: "supported",
    networkModes: ["none", "public-egress"],
    portableMemory: false,
  };
  const fallback = selectRuntime(preference, required, proof);
  assert.equal(fallback.runtime.kind, "podman");
  assert.equal(fallback.fallbackReason, "network-policy");
});

test("preparing bootstrap freezes eligibility before effects and publishes readiness only after verification", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  let excluded = false,
    fail = true;
  const calls: string[] = [];
  const evidence = async () =>
    admissions().map((a) => {
      if (a.runtime.kind === "gvisor" && excluded)
        return {
          runtime: a.runtime,
          evidenceId: "operator-exclusion",
          status: "unsupported" as const,
          reason: "workload-compatibility" as const,
        };
      return a.status === "supported"
        ? { ...a, status: "eligible" as const }
        : a;
    });
  const preferred: RuntimePreference = {
    mode: "gvisor-preferred",
    allowPodmanFallbackFor: ["workload-compatibility"],
  };
  const make = () =>
    new PreparingRuntimeBootstrap(
      state,
      preferred,
      requirements,
      evidence,
      (runtime) => ({
        ensure: async () => {
          calls.push(runtime.kind);
          if (fail) throw Error("lost bootstrap acknowledgement");
        },
      }),
    );
  const first = make();
  await assert.rejects(first.ensure("fresh-host"), /lost bootstrap/);
  assert.equal(await first.decision("fresh-host"), null);
  excluded = true;
  await assert.rejects(make().ensure("fresh-host"), /not permitted/);
  assert.deepEqual(calls, ["gvisor"]);
  excluded = false;
  fail = false;
  await make().ensure("fresh-host");
  assert.equal((await first.decision("fresh-host"))?.runtime.kind, "gvisor");
});

test("preparing bootstrap allows only approved exclusions, keeps Podman fixed, and rejects RAM downgrade", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  const evidence = async () =>
    admissions().map((a) =>
      a.runtime.kind === "gvisor"
        ? {
            runtime: a.runtime,
            evidenceId: "operator-exclusion",
            status: "unsupported" as const,
            reason: "workload-compatibility" as const,
          }
        : a.status === "supported"
          ? { ...a, status: "eligible" as const }
          : a,
    );
  const preference: RuntimePreference = {
    mode: "gvisor-preferred",
    allowPodmanFallbackFor: ["workload-compatibility"],
  };
  let calls = 0;
  const bootstrap = new PreparingRuntimeBootstrap(
    state,
    preference,
    requirements,
    evidence,
    (runtime) => ({
      ensure: async () => {
        assert.equal(runtime.kind, "podman");
        calls++;
      },
    }),
  );
  await bootstrap.ensure("fallback-host");
  assert.equal(
    (await bootstrap.decision("fallback-host"))?.fallbackReason,
    "workload-compatibility",
  );
  await assert.rejects(
    new PreparingRuntimeBootstrap(
      state,
      preference,
      { ...requirements, portableMemory: true },
      evidence,
      () => ({
        ensure: async () => {
          calls++;
        },
      }),
    ).ensure("ram-host"),
    /cannot meet/,
  );
  await assert.rejects(
    new PreparingRuntimeBootstrap(
      state,
      preference,
      requirements,
      async () => [
        { runtime: GVISOR_RUNTIME, evidenceId: "uncertain", status: "unknown" },
        (await evidence())[1]!,
      ],
      () => ({
        ensure: async () => {
          calls++;
        },
      }),
    ).ensure("unknown-host"),
    /uncertain/,
  );
  assert.equal(calls, 1);
});
