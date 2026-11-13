import type { HostAdapters, HostFactory } from "../core/composition.js";
import {
  BoxdControlChannel,
  BoxdStreamTransport,
  BoxdTransport,
} from "../transport/boxd.js";
import { type BoxdClient, BoxdHostProvider } from "./boxd.js";
import { OwnedMachineBootstrap } from "./machine-bootstrap.js";
import type { MachineRuntimeOptions } from "./machine-options.js";
import { machineRuntimeOptions } from "./machine-options.js";

/** Optional SDK injection. Build the client with maxRetries:0 and an explicit key.
 * The identity must identify one stable organization/endpoint/region namespace. */
export function boxdHostFactory(
  client: BoxdClient,
  options: {
    id: string;
    vcpu?: number;
    memory?: string;
    close?: () => void | Promise<void>;
  } & MachineRuntimeOptions,
): HostFactory {
  const policy = machineRuntimeOptions(options);
  options = { ...options, ...policy };
  return {
    kind: "factory",
    configuration: JSON.parse(
      JSON.stringify({
        vcpu: options.vcpu ?? 2,
        memory: options.memory ?? `${(options.vcpu ?? 2) * 4}G`,
        ...policy,
      }),
    ),
    id: options.id,
    create({ state, poolId, approvedImages }): HostAdapters {
      let provider: BoxdHostProvider;
      const channel = new BoxdControlChannel(client, (host) =>
        provider.owned(host),
      );
      const bootstrap = new OwnedMachineBootstrap(
        state,
        channel,
        poolId,
        [...approvedImages],
        "boxd",
        options,
      );
      provider = new BoxdHostProvider(
        state,
        client,
        poolId,
        (host) => bootstrap.ensure(host),
        options,
      );
      return {
        provider,
        transport: new BoxdTransport(channel),
        streamTransport: new BoxdStreamTransport(client, (host) =>
          provider.owned(host),
        ),
        ...(options.close ? { close: options.close } : {}),
      };
    },
  };
}
