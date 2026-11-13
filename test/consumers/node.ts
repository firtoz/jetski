import type { StateStore } from "@firtoz/jetski/core";
import { type NodeOptions, openJetski } from "@firtoz/jetski/node";
import { BoatApi, BoatMachineProvider } from "@firtoz/jetski/providers/boat";

export async function example(options: NodeOptions, state: StateStore) {
  const controller = await openJetski(options);
  const session = await controller.create();
  const command = await session.startCommand(["echo", "hello"]);
  const result = await session.command(command.id).wait();
  const text: string = result.stdout;
  const summary = await controller.resolvedConfiguration();
  const intents = await controller.operationIntents();
  const machines = new BoatMachineProvider(state, new BoatApi("private"));
  // @ts-expect-error physical machine readiness does not attest a sandbox runtime
  machines.capabilities();
  // @ts-expect-error provider unions retain their provider-specific requirements
  openJetski({ ...options, provider: { kind: "boxd", token: "private" } });
  await controller.close();
  return { text, summary, intents };
}
