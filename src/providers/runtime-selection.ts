import { identifier, type StateStore } from "../core/contracts.js";
import type { RuntimePolicy } from "../core/runtime-policy.js";
import {
  bindRuntimeSelection,
  type RuntimeAdmission,
  type RuntimePreference,
  type RuntimeRequirements,
  selectRuntime,
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
