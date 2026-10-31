import type { HostProvider, StateStore } from "../core/contracts.js";
import type { HostStreamTransport } from "../core/host-stream.js";
import type { HostTransport } from "../core/transport.js";
import type { BoatMachineType } from "../providers/boat.js";
import type { SshHost } from "../transport/ssh.js";
export type HostConfig =
  | { kind: "ssh"; hosts: SshHost[] }
  | { kind: "boat"; tokenEnv: string; machine?: BoatMachineType };
/** Selected adapters only. Boat installs on allocated machines, never locally. */
export async function standaloneHosts(
  state: StateStore,
  config: HostConfig,
  poolId: string,
  approvedImages: string[],
  environment = process.env,
): Promise<{
  provider: HostProvider;
  transport: HostTransport;
  streamTransport?: HostStreamTransport;
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
  const [{ BoatApi, BoatHostProvider }, { BoatTransport }, { BoatBootstrap }] =
    await Promise.all([
      import("../providers/boat.js"),
      import("../transport/boat.js"),
      import("../providers/boat-bootstrap.js"),
    ]);
  const api = new BoatApi(environment[config.tokenEnv]!);
  const transport = new BoatTransport(state, api);
  const bootstrap = new BoatBootstrap(state, api, poolId, approvedImages);
  return {
    transport,
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
