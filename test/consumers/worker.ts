import {
  type CheckpointStore,
  type HostFactory,
  SandboxManager,
  type StateStore,
} from "@firtoz/jetski/core";
import { Jetski, type SandboxSession } from "@firtoz/jetski/sdk";

export async function observe(jetski: Jetski) {
  const session: SandboxSession = await jetski.get("saved-sandbox");
  const command = session.command("saved-command");
  for await (const part of command.output("stdout", { offset: 0 })) {
    const next: number = part.nextOffset;
    const bytes: Uint8Array = part.bytes;
    void [next, bytes];
  }
  // @ts-expect-error channel names are a closed union
  command.output("combined");
  return command.wait();
}
export async function compose(
  factory: HostFactory,
  state: StateStore,
  objects: CheckpointStore,
) {
  const adapters = await factory.create({
    state,
    poolId: "persisted-pool",
    approvedImages: [],
  });
  return new SandboxManager(
    state,
    adapters.provider,
    adapters.transport,
    objects,
    {
      poolId: "persisted-pool",
      approvedImages: [],
      ...(adapters.streamTransport
        ? { streamTransport: adapters.streamTransport }
        : {}),
    },
  );
}
