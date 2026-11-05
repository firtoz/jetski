import type {
  HostProvider,
  NetworkFilterBackend,
  RuntimeNetworkMode,
  RuntimeStorageMode,
  StateStore,
} from "../core/contracts.js";
import { assertNever } from "../core/exhaustive.js";
import {
  HOST_LIFECYCLE_LIMITS,
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
import {
  type BoxdHostConfig,
  validateBoxdHostConfig,
} from "../providers/boxd-config.js";

export type { BoxdHostConfig } from "../providers/boxd-config.js";

import type { SshHost } from "../transport/ssh.js";
export type HostConfig =
  | BoxdHostConfig
  | { kind: "ssh"; hosts: SshHost[] }
  | {
      kind: "boat";
      tokenEnv: string;
      machine?: BoatMachineType;
      networkMode?: RuntimeNetworkMode;
      networkFilter?: NetworkFilterBackend;
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
  close?: () => void | Promise<void>;
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
  if (config.kind === "boxd") {
    validateBoxdHostConfig(config);
    const token = environment[config.tokenEnv];
    if (!token) throw Error("boxd credential environment variable missing");
    const [{ Boxd }, { boxdHostFactory }] = await Promise.all([
      import("@boxd-sh/sdk"),
      import("../providers/boxd-hosts.js"),
    ]);
    // Explicit credentials, endpoint and region avoid metadata discovery/env drift.
    const client = new Boxd({
      apiKey: token,
      region: config.region,
      baseURL: config.baseURL ?? "https://boxd.sh:9443",
      maxRetries: 0,
      timeout: 330_000,
    });
    try {
      const factory = boxdHostFactory(client, {
        ...config,
        id: config.namespace,
        close: () => client.close(),
      });
      if (factory.kind !== "factory") throw Error("Invalid boxd factory");
      const adapters = await factory.create({ state, poolId, approvedImages });
      const idle = hostLifecycle(lifecycle).idle;
      if (idle.mode !== "adaptive" || !config.idlePricing) return adapters;
      const { BoxdIdlePriceSource } = await import(
        "../providers/boxd-pricing.js"
      );
      const pricing = new BoxdIdlePriceSource(
        async (signal) => {
          const reader = new Boxd({
            apiKey: token,
            region: config.region,
            baseURL: config.baseURL ?? "https://boxd.sh:9443",
            maxRetries: 0,
            timeout: HOST_LIFECYCLE_LIMITS.priceRequestMs,
          });
          const stop = () => reader.close();
          signal.throwIfAborted();
          signal.addEventListener("abort", stop, { once: true });
          try {
            const now = Date.now();
            const usage = await reader.orgs.usage({
              since: new Date(now - 60000),
              until: new Date(now),
            });
            return { currency: usage.currency, rates: usage.rates };
          } finally {
            signal.removeEventListener("abort", stop);
            await reader.close();
          }
        },
        { vcpu: config.vcpu ?? 2, memoryGiB: (config.vcpu ?? 2) * 4 },
        {
          currency: idle.currency ?? "USD",
          maxIdleSpendMicros: idle.maxIdleSpendMicros,
          diskGiB: config.idlePricing.diskGiB,
        },
      );
      return { ...adapters, idlePriceSource: pricing };
    } catch (error) {
      await client.close();
      throw error;
    }
  }
  if (config.kind === "boat") {
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
      config.networkFilter,
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
  return assertNever(config);
}
