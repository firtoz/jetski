import { readFile } from "node:fs/promises";
import type {
  NetworkFilterBackend,
  RuntimeNetworkMode,
  RuntimeStorageMode,
  StateStore,
} from "../core/contracts.js";
import { PODMAN_RUNTIME, type RuntimePolicy } from "../core/runtime-policy.js";
import type { StageTimingSink } from "../core/timing.js";
import type { BoatApi } from "./boat.js";
import {
  BOAT_BOOTSTRAP_MODULES,
  EmbeddedBoatBootstrap,
} from "./boat-bootstrap-embedded.js";

/** Node default loader; embedded deployments supply the same assets at build time. */
export class BoatBootstrap extends EmbeddedBoatBootstrap {
  constructor(
    state: StateStore,
    api: BoatApi,
    poolId: string,
    images: string[],
    networkMode: RuntimeNetworkMode = "none",
    storageMode: RuntimeStorageMode = "default",
    runtime: RuntimePolicy = PODMAN_RUNTIME,
    workloadInit?: readonly string[],
    networkFilter: NetworkFilterBackend = "auto",
    timings?: StageTimingSink,
  ) {
    super(
      state,
      api,
      poolId,
      images,
      async () => {
        const root = new URL("../../host/", import.meta.url);
        const files: Record<string, Uint8Array> = {};
        for (const name of BOAT_BOOTSTRAP_MODULES) {
          files[name] = await readFile(
            new URL(name.endsWith(".c") ? `native/${name}` : name, root),
          );
        }
        return {
          files,
          installer: await readFile(new URL("install_bundle.py", root)),
        };
      },
      networkMode,
      storageMode,
      undefined,
      runtime,
      workloadInit,
      networkFilter,
      timings,
    );
  }
}
