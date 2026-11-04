import {
  canonical,
  identifier,
  type Json,
  type StateStore,
} from "../core/contracts.js";
import type { RuntimePolicy } from "../core/runtime-policy.js";
import {
  bindRuntimeSelection,
  type RuntimeAdmission,
  type RuntimeDecision,
  type RuntimeEligibility,
  type RuntimePreference,
  type RuntimeRequirements,
  selectRuntime,
  selectRuntimeCandidate,
} from "../core/runtime-selection.js";

/** Opt-in bootstrap composition. Probe implementations must prove host/workload
 * support and enforced limits, and report unknown instead of guessing on errors.
 * The selected runtime is immutable per host. Bootstrap errors propagate: they
 * never cause an automatic downgrade or a second native execution attempt.
 */
export class SelectingRuntimeBootstrap {
  constructor(
    private readonly state: StateStore,
    private readonly preference: RuntimePreference,
    private readonly requirements: RuntimeRequirements,
    private readonly admission: (host: string) => Promise<RuntimeAdmission[]>,
    private readonly bootstrap: (runtime: RuntimePolicy) => {
      ensure(host: string): Promise<void>;
    },
  ) {
    this.preference = structuredClone(preference);
    this.requirements = structuredClone(requirements);
  }
  async ensure(host: string): Promise<void> {
    identifier(host);
    const admissions = await this.admission(host);
    const decision = await bindRuntimeSelection(
      this.state,
      host,
      this.preference,
      this.requirements,
      admissions,
    );
    // A persisted choice prevents switching; it does not certify current health.
    selectRuntime(
      {
        mode:
          decision.runtime.kind === "gvisor"
            ? "gvisor-required"
            : "podman-only",
      },
      this.requirements,
      admissions,
    );
    await this.bootstrap(decision.runtime).ensure(host);
  }
}

/** Two-stage admission for fresh hosts. Freeze the candidate before native
 * preparation, then publish a verified selection only after bootstrap succeeds.
 * A partial/failed bootstrap cannot choose another runtime on a later attempt. */
export class PreparingRuntimeBootstrap {
  private readonly preference: RuntimePreference;
  private readonly requirements: RuntimeRequirements;
  constructor(
    private readonly state: StateStore,
    preference: RuntimePreference,
    requirements: RuntimeRequirements,
    private readonly eligibility: (
      host: string,
    ) => Promise<RuntimeEligibility[]>,
    private readonly bootstrap: (runtime: RuntimePolicy) => {
      ensure(host: string): Promise<void>;
    },
  ) {
    this.preference = structuredClone(preference);
    this.requirements = structuredClone(requirements);
  }
  async ensure(host: string): Promise<void> {
    identifier(host);
    const evidence = await this.eligibility(host);
    const request = canonical({
      preference: this.preference,
      requirements: this.requirements,
    });
    const decision = await this.state.transaction((tx) => {
      const key = `runtime-candidate/${host}`;
      const prior = tx.get<{ request: string; decision: RuntimeDecision }>(key);
      if (prior) {
        if (prior.request !== request)
          throw Error("Runtime policy changed; replace host explicitly");
        return prior.decision;
      }
      if (tx.get(`runtime-selection/${host}`))
        throw Error("Existing runtime selection requires reconciliation");
      const candidate = selectRuntimeCandidate(
        this.preference,
        this.requirements,
        evidence,
      );
      tx.put(key, { request, decision: candidate } as Json);
      return candidate;
    });
    selectRuntimeCandidate(
      {
        mode:
          decision.runtime.kind === "gvisor"
            ? "gvisor-required"
            : "podman-only",
      },
      this.requirements,
      evidence,
    );
    await this.bootstrap(decision.runtime).ensure(host);
    await this.state.transaction((tx) => {
      const prior = tx.get<{ request: string; decision: RuntimeDecision }>(
        `runtime-candidate/${host}`,
      );
      if (!prior || canonical(prior) !== canonical({ request, decision }))
        throw Error("Runtime candidate changed during bootstrap");
      const ready = tx.get<{ request: string; decision: RuntimeDecision }>(
        `runtime-selection/${host}`,
      );
      if (ready && canonical(ready) !== canonical(prior))
        throw Error("Runtime selection changed during bootstrap");
      tx.put(`runtime-selection/${host}`, { request, decision } as Json);
    });
  }
  decision(host: string): Promise<RuntimeDecision | null> {
    identifier(host);
    return this.state.transaction(
      (tx) =>
        tx.get<{ decision: RuntimeDecision }>(`runtime-selection/${host}`)
          ?.decision ?? null,
    );
  }
}
