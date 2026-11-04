import {
  canonical,
  identifier,
  type Json,
  RUNTIME_NETWORK_MODES,
  type RuntimeNetworkMode,
  type StateStore,
} from "./contracts.js";
import { type RuntimePolicy, validateRuntimePolicy } from "./runtime-policy.js";

export const RUNTIME_FALLBACK_REASONS = [
  "host-platform",
  "host-backend",
  "namespace-support",
  "resource-enforcement",
  "workload-compatibility",
  "network-policy",
  "memory-capability",
] as const;
export type RuntimeFallbackReason = (typeof RUNTIME_FALLBACK_REASONS)[number];
export type RuntimePreference =
  | { mode: "podman-only" }
  | { mode: "gvisor-required" }
  | {
      mode: "gvisor-preferred";
      allowPodmanFallbackFor: RuntimeFallbackReason[];
    };
export type RuntimeRequirements = {
  networkMode: RuntimeNetworkMode;
  portableMemory: boolean;
};
/** Trusted adapter admission evidence, never inferred from arbitrary workload errors.
 * Supported means isolation and effective resource enforcement have been checked.
 */
export type RuntimeAdmission =
  | {
      runtime: RuntimePolicy;
      evidenceId: string;
      status: "supported";
      networkModes: RuntimeNetworkMode[];
      portableMemory: boolean;
    }
  | {
      runtime: RuntimePolicy;
      evidenceId: string;
      status: "unsupported";
      reason: RuntimeFallbackReason;
    }
  | { runtime: RuntimePolicy; evidenceId: string; status: "unknown" };
export type RuntimeDecision = {
  version: 1;
  runtime: RuntimePolicy;
  evidenceId: string;
  fallbackReason: RuntimeFallbackReason | null;
};

/** Prerequisites and operator workload qualification only. Eligibility is not
 * proof of effective isolation: a runtime bootstrap must still verify that
 * before allowing workload execution. Unknown never authorizes fallback. */
export type RuntimeEligibility =
  | (Omit<Extract<RuntimeAdmission, { status: "supported" }>, "status"> & {
      status: "eligible";
    })
  | Exclude<RuntimeAdmission, { status: "supported" }>;

export function selectRuntimeCandidate(
  preference: RuntimePreference,
  requirements: RuntimeRequirements,
  eligibility: RuntimeEligibility[],
): RuntimeDecision {
  if (
    !Array.isArray(eligibility) ||
    eligibility.some(
      (entry) =>
        !entry ||
        !["eligible", "unsupported", "unknown"].includes(entry.status),
    )
  )
    throw Error("Invalid runtime prerequisite eligibility");
  return selectRuntime(
    preference,
    requirements,
    eligibility.map((entry) =>
      entry.status === "eligible" ? { ...entry, status: "supported" } : entry,
    ),
  );
}

function validate(
  preference: RuntimePreference,
  requirements: RuntimeRequirements,
  admissions: RuntimeAdmission[],
) {
  if (
    !preference ||
    !["podman-only", "gvisor-required", "gvisor-preferred"].includes(
      preference.mode,
    )
  )
    throw Error("Invalid runtime preference");
  if (
    !requirements ||
    !RUNTIME_NETWORK_MODES.includes(requirements.networkMode) ||
    typeof requirements.portableMemory !== "boolean"
  )
    throw Error("Invalid runtime requirements");
  if (
    preference.mode === "gvisor-preferred" &&
    (!Array.isArray(preference.allowPodmanFallbackFor) ||
      preference.allowPodmanFallbackFor.length >
        RUNTIME_FALLBACK_REASONS.length ||
      new Set(preference.allowPodmanFallbackFor).size !==
        preference.allowPodmanFallbackFor.length ||
      preference.allowPodmanFallbackFor.some(
        (reason) => !RUNTIME_FALLBACK_REASONS.includes(reason),
      ))
  )
    throw Error("Invalid runtime fallback permission");
  if (
    !Array.isArray(admissions) ||
    admissions.length !== 2 ||
    new Set(admissions.map((a) => a.runtime?.kind)).size !== 2
  )
    throw Error("Both runtime admissions required");
  for (const admission of admissions) {
    validateRuntimePolicy(admission.runtime);
    identifier(admission.evidenceId);
    if (admission.status === "supported") {
      if (
        !Array.isArray(admission.networkModes) ||
        admission.networkModes.some(
          (mode) => !RUNTIME_NETWORK_MODES.includes(mode),
        ) ||
        typeof admission.portableMemory !== "boolean"
      )
        throw Error("Invalid runtime admission");
    } else if (admission.status === "unsupported") {
      if (!RUNTIME_FALLBACK_REASONS.includes(admission.reason))
        throw Error("Invalid unsupported capability");
    } else if (admission.status !== "unknown")
      throw Error("Invalid runtime admission");
  }
}
function unsupported(
  admission: RuntimeAdmission,
  requirements: RuntimeRequirements,
): RuntimeFallbackReason | null {
  if (admission.status === "unknown")
    throw Error("Runtime support uncertain; no automatic fallback");
  if (admission.status === "unsupported") return admission.reason;
  if (!admission.networkModes.includes(requirements.networkMode))
    return "network-policy";
  if (requirements.portableMemory && !admission.portableMemory)
    return "memory-capability";
  return null;
}
/** Admission-time choice only. Never use after a command, uncertain native effect,
 * corrupt checkpoint or failed save. A required capability is never downgraded.
 */
export function selectRuntime(
  preference: RuntimePreference,
  requirements: RuntimeRequirements,
  admissions: RuntimeAdmission[],
): RuntimeDecision {
  validate(preference, requirements, admissions);
  const podman = admissions.find((a) => a.runtime.kind === "podman")!;
  const gvisor = admissions.find((a) => a.runtime.kind === "gvisor")!;
  if (preference.mode === "podman-only") {
    if (unsupported(podman, requirements))
      throw Error("Podman cannot meet runtime requirements");
    return {
      version: 1,
      runtime: structuredClone(podman.runtime),
      evidenceId: podman.evidenceId,
      fallbackReason: null,
    };
  }
  const reason = unsupported(gvisor, requirements);
  if (!reason)
    return {
      version: 1,
      runtime: structuredClone(gvisor.runtime),
      evidenceId: gvisor.evidenceId,
      fallbackReason: null,
    };
  if (
    preference.mode !== "gvisor-preferred" ||
    !preference.allowPodmanFallbackFor.includes(reason)
  )
    throw Error(
      "Required gVisor capability unavailable; fallback not permitted",
    );
  if (unsupported(podman, requirements))
    throw Error("Fallback cannot meet runtime requirements");
  return {
    version: 1,
    runtime: structuredClone(podman.runtime),
    evidenceId: podman.evidenceId,
    fallbackReason: reason,
  };
}
/** Persist before host bootstrap. The caller supplies one stable physical-host ID.
 * Subsequent observations return the bound decision, never replace its runtime.
 */
export async function bindRuntimeSelection(
  state: StateStore,
  host: string,
  preference: RuntimePreference,
  requirements: RuntimeRequirements,
  admissions: RuntimeAdmission[],
): Promise<RuntimeDecision> {
  preference = structuredClone(preference);
  requirements = structuredClone(requirements);
  admissions = structuredClone(admissions);
  identifier(host);
  validate(preference, requirements, admissions);
  const request = canonical({ preference, requirements });
  return state.transaction((tx) => {
    const key = `runtime-selection/${host}`;
    const prior = tx.get<{ request: string; decision: RuntimeDecision }>(key);
    if (prior) {
      if (prior.request !== request)
        throw Error("Runtime policy changed; replace host explicitly");
      validateRuntimePolicy(prior.decision.runtime);
      return structuredClone(prior.decision);
    }
    const decision = selectRuntime(preference, requirements, admissions);
    tx.put(key, { request, decision } as Json);
    return decision;
  });
}
