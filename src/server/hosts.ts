import type {
  HostProvider,
  RuntimeNetworkMode,
  RuntimeStorageMode,
  StateStore,
} from "../core/contracts.js";
import {
  type HostLifecycle,
  hostLifecycle,
  type IdlePriceSource,
} from "../core/host-lifecycle.js";
import type { HostStreamTransport } from "../core/host-stream.js";
import {
  PODMAN_RUNTIME,
  type RuntimePolicy,
  validateRuntimePolicy,
  validateWorkloadInit,
} from "../core/runtime-policy.js";
import type { HostTransport } from "../core/transport.js";
import type { BoatMachineType } from "../providers/boat.js";
import type { SshHost } from "../transport/ssh.js";
export type HostConfig =
  | { kind: "ssh"; hosts: SshHost[] }
  | {
      kind: "boat";
      tokenEnv: string;
      machine?: BoatMachineType;
      networkMode?: RuntimeNetworkMode;
      storageMode?: RuntimeStorageMode;
      runtime?: RuntimePolicy;
      workloadInit?: readonly string[];
    };
/** Selected adapters only. Boat installs on allocated machines, never locally. */
export async function standaloneHosts(
  state: StateStore,
  config: HostConfig,
  poolId: string,
  approvedImages: string[],
  environment = process.env,
  lifecycle?: HostLifecycle,
): Promise<{
  provider: HostProvider;
  transport: HostTransport;
  streamTransport?: HostStreamTransport;
  idlePriceSource?: IdlePriceSource;
}> {
  if (config.kind === "ssh") {
    const [{ SshTransport }, { SshHostProvider }] = await Promise.all([
      import("../transport/ssh.js"),
      import("../providers/ssh.js"),
    ]);
    const transport = new SshTransport(config.hosts);
    return {
      transport,
      streamTransport: transport,
      provider: new SshHostProvider(
        config.hosts.map((host) => host.id),
        state,
        transport,
      ),
    };
  }
  if (config.kind !== "boat") throw Error("Unsupported machine host provider");
  if (
    !/^[A-Z][A-Z0-9_]{0,127}$/.test(config.tokenEnv) ||
    !environment[config.tokenEnv]
  )
    throw Error("Boat credential environment variable missing or invalid");
  const [
    { BoatApi, BoatHostProvider },
    { BoatTransport },
    { BoatBootstrap },
    { BoatStreamTransport },
    { BoatIdlePriceSource },
  ] = await Promise.all([
    import("../providers/boat.js"),
    import("../transport/boat.js"),
    import("../providers/boat-bootstrap.js"),
    import("../transport/boat-stream.js"),
    import("../providers/boat-pricing.js"),
  ]);
  validateRuntimePolicy(config.runtime ?? PODMAN_RUNTIME);
  validateWorkloadInit(config.workloadInit);
  const api = new BoatApi(environment[config.tokenEnv]!);
  const idle = hostLifecycle(lifecycle).idle;
  const transport = new BoatTransport(state, api);
  const bootstrap = new BoatBootstrap(
    state,
    api,
    poolId,
    approvedImages,
    config.networkMode,
    config.storageMode,
    config.runtime,
    config.workloadInit,
  );
  return {
    transport,
    ...(idle.mode === "adaptive"
      ? {
          idlePriceSource: new BoatIdlePriceSource(
            api,
            config.machine ?? "small",
            idle.maxIdleSpendMicros,
          ),
        }
      : {}),
    streamTransport: new BoatStreamTransport(state, api),
    provider: new BoatHostProvider(
      state,
      api,
      transport,
      config.machine ?? "small",
      Date.now,
      bootstrap,
    ),
  };
}
