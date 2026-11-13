import {
  type CheckpointStore,
  type HostProvider,
  type ManagerOptions,
  SandboxManager,
  type StateStore,
} from "@firtoz/jetski/core";
import { loadBoatBootstrapAssets } from "@firtoz/jetski/host-assets";
import { BoatApi } from "@firtoz/jetski/providers/boat";
import { boatHostFactory } from "@firtoz/jetski/providers/boat-hosts";

export function compose(
  state: StateStore,
  objects: CheckpointStore,
  token: string,
  poolId: string,
  approvedImages: string[],
  wrap: (provider: HostProvider) => HostProvider,
  policy: Omit<ManagerOptions, "poolId" | "approvedImages">,
) {
  const factory = boatHostFactory(new BoatApi(token), {
    id: "owned-machine-namespace",
    loadAssets: loadBoatBootstrapAssets,
    runtimeSelection: {
      preference: { mode: "gvisor-required" },
      workload: "qualified",
      portableMemory: false,
    },
  });
  const hosts = factory.create({ state, poolId, approvedImages });
  const manager = new SandboxManager(
    state,
    wrap(hosts.provider),
    hosts.transport,
    objects,
    {
      ...policy,
      poolId,
      approvedImages,
      ...(hosts.streamTransport
        ? { streamTransport: hosts.streamTransport }
        : {}),
      ...(hosts.idlePriceSource
        ? { idlePriceSource: hosts.idlePriceSource }
        : {}),
    },
  );
  return { manager, hosts };
}
