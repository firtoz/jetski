import type { HostAdapters, HostFactory } from "../core/composition.js";
import type { HostStreamTransport } from "../core/host-stream.js";
import type {
  RuntimeDecision,
  RuntimePreference,
} from "../core/runtime-selection.js";
import type { StageTimingSink } from "../core/timing.js";
import { BoatTransport } from "../transport/boat.js";
import { BoatApi, BoatHostProvider, type BoatMachineType } from "./boat.js";
import {
  type BoatBootstrapAssets,
  EmbeddedBoatBootstrap,
} from "./boat-bootstrap-embedded.js";
import { BoatIdlePriceSource } from "./boat-pricing.js";
import {
  BoatRuntimeEligibility,
  type BoatWorkloadQualification,
} from "./boat-runtime-selection.js";
import {
  type MachineRuntimeOptions,
  machineRuntimeOptions,
} from "./machine-options.js";
import { PreparingRuntimeBootstrap } from "./runtime-selection.js";

export type BoatHostFactoryOptions = MachineRuntimeOptions & {
  id: string;
  machine?: BoatMachineType;
  archiveReads?: boolean;
  archiveWrites?: boolean;
  checkpointUploadConcurrency?: 1 | 2;
  /** Inject streams on platforms with their own transport; defaults to none. */
  streamTransport?: HostStreamTransport;
  loadAssets: () => Promise<BoatBootstrapAssets>;
  maxIdleSpendMicros?: number;
  timings?: StageTimingSink;
  runtimeSelection?: {
    preference: RuntimePreference;
    workload: BoatWorkloadQualification;
    portableMemory: boolean;
  };
};
export type BoatHostAdapters = HostAdapters & {
  api: BoatApi;
  /** Only verified selections are returned. Null before bootstrap or without selection. */
  runtimeDecision(host: string): Promise<RuntimeDecision | null>;
};
/** Generic embedded composition; no controller listener, SQLite, filesystem or SSH
 * client imports. Workers need their Node crypto/path/Buffer compatibility support.
 * State, durable scheduling, storage, identity/policy wrappers and telemetry stay injected. */
export function boatHostFactory(
  api: BoatApi,
  input: BoatHostFactoryOptions,
): Omit<HostFactory, "create"> & {
  create(context: Parameters<HostFactory["create"]>[0]): BoatHostAdapters;
} {
  if (input.runtimeSelection && input.runtime)
    throw Error("Choose fixed runtime or runtime selection");
  const options = { ...input, ...machineRuntimeOptions(input) };
  const selection = input.runtimeSelection
    ? structuredClone(input.runtimeSelection)
    : undefined;
  return {
    kind: "factory",
    id: options.id,
    configuration: JSON.parse(
      JSON.stringify({
        machine: options.machine ?? "small",
        runtime: options.runtime,
        networkMode: options.networkMode,
        networkFilter: options.networkFilter,
        storageMode: options.storageMode,
        workloadInit: options.workloadInit,
        archiveReads: options.archiveReads ?? false,
        archiveWrites: options.archiveWrites ?? false,
        checkpointUploadConcurrency: options.checkpointUploadConcurrency ?? 1,
        maxIdleSpendMicros: options.maxIdleSpendMicros,
        streams: options.streamTransport !== undefined,
        runtimeSelection: selection,
      }),
    ),
    create({ state, poolId, approvedImages }): BoatHostAdapters {
      const transport = new BoatTransport(state, api, undefined, {
        ...(options.timings ? { timings: options.timings } : {}),
        ...(options.archiveWrites === undefined
          ? {}
          : { archiveWrites: options.archiveWrites }),
        ...(options.checkpointUploadConcurrency === undefined
          ? {}
          : {
              checkpointUploadConcurrency: options.checkpointUploadConcurrency,
            }),
        ...(options.archiveReads === undefined
          ? {}
          : { archiveReads: options.archiveReads }),
      });
      const loadAssets = options.loadAssets;
      const fixed = (runtime: typeof options.runtime) =>
        new EmbeddedBoatBootstrap(
          state,
          api,
          poolId,
          [...approvedImages],
          loadAssets,
          options.networkMode,
          options.storageMode,
          undefined,
          runtime,
          options.workloadInit,
          options.networkFilter,
          options.timings,
        );
      const eligibility = selection
        ? new BoatRuntimeEligibility(state, api, selection.workload)
        : undefined;
      const selected =
        selection && eligibility
          ? new PreparingRuntimeBootstrap(
              state,
              selection.preference,
              {
                networkMode: options.networkMode,
                portableMemory: selection.portableMemory,
              },
              (host) => eligibility.inspect(host),
              fixed,
            )
          : undefined;
      return {
        api,
        transport,
        provider: new BoatHostProvider(
          state,
          api,
          transport,
          options.machine,
          Date.now,
          selected ?? fixed(options.runtime),
        ),
        ...(options.streamTransport
          ? { streamTransport: options.streamTransport }
          : {}),
        ...(options.maxIdleSpendMicros === undefined
          ? {}
          : {
              idlePriceSource: new BoatIdlePriceSource(
                api,
                options.machine ?? "small",
                options.maxIdleSpendMicros,
              ),
            }),
        runtimeDecision: (host) =>
          selected ? selected.decision(host) : Promise.resolve(null),
      };
    },
  };
}
