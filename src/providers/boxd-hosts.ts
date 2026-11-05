import type { NodeHostAdapters, NodeProvider } from "../node.js";
import {
  BoxdControlChannel,
  BoxdStreamTransport,
  BoxdTransport,
} from "../transport/boxd.js";
import { type BoxdClient, BoxdHostProvider } from "./boxd.js";
import { OwnedMachineBootstrap } from "./machine-bootstrap.js";

/** Optional SDK injection. Build the client with maxRetries:0 and an explicit key.
 * The identity must identify one stable organization/endpoint/region namespace. */
export function boxdHostFactory(
  client: BoxdClient,
  options: {
    id: string;
    vcpu?: number;
    memory?: string;
    close?: () => void | Promise<void>;
  },
): NodeProvider {
  return {
    kind: "factory",
    id: options.id,
    create({ state, poolId, approvedImages }): NodeHostAdapters {
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
