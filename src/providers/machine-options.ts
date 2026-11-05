import {
  NETWORK_FILTER_BACKENDS,
  type NetworkFilterBackend,
  RUNTIME_NETWORK_MODES,
  RUNTIME_STORAGE_MODES,
  type RuntimeNetworkMode,
  type RuntimeStorageMode,
} from "../core/contracts.js";
import {
  PODMAN_RUNTIME,
  type RuntimePolicy,
  validateRuntimePolicy,
  validateWorkloadInit,
} from "../core/runtime-policy.js";

/** Immutable operator policy, shared across installable Linux machine hosts. */
export type MachineRuntimeOptions = {
  networkMode?: RuntimeNetworkMode;
  networkFilter?: NetworkFilterBackend;
  storageMode?: RuntimeStorageMode;
  runtime?: RuntimePolicy;
  workloadInit?: readonly string[];
};
export function machineRuntimeOptions(input: MachineRuntimeOptions) {
  const runtime = structuredClone(input.runtime ?? PODMAN_RUNTIME);
  const networkMode = input.networkMode ?? "none";
  const networkFilter = input.networkFilter ?? "auto";
  if (!NETWORK_FILTER_BACKENDS.includes(networkFilter))
    throw Error("Unsupported network filter backend");
  const storageMode = input.storageMode ?? "default";
  validateRuntimePolicy(runtime);
  validateWorkloadInit(input.workloadInit);
  if (!RUNTIME_NETWORK_MODES.includes(networkMode))
    throw Error("Unsupported runtime network policy");
  if (!RUNTIME_STORAGE_MODES.includes(storageMode))
    throw Error("Unsupported runtime storage policy");
  if (runtime.kind === "gvisor" && networkMode === "egress")
    throw Error("gVisor requires a qualified network policy");
  return {
    runtime,
    networkMode,
    networkFilter,
    storageMode,
    ...(input.workloadInit === undefined
      ? {}
      : { workloadInit: [...input.workloadInit] }),
  };
}
