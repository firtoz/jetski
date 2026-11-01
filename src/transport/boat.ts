import type { StateStore } from "../core/contracts.js";
import { identifier } from "../core/contracts.js";
import {
  HOST_CONTROL_TIMEOUT_MS,
  HOST_PROTOCOL_VERSION,
  type HostRequest,
  type HostResponse,
  type HostTransport,
  HostTransportError,
} from "../core/transport.js";
import type { BoatApi } from "../providers/boat.js";
import { BoatControlChannel } from "./boat-channel.js";

/** Fixed privileged control program; workload bytes enter only through stdin. */
export class BoatTransport implements HostTransport {
  private readonly channel: BoatControlChannel;
  constructor(
    state: StateStore,
    api: BoatApi,
    timeoutSeconds = HOST_CONTROL_TIMEOUT_MS / 1000,
  ) {
    this.channel = new BoatControlChannel(state, api, timeoutSeconds);
  }
  async request(
    host: string,
    request: HostRequest,
    signal?: AbortSignal,
  ): Promise<HostResponse> {
    identifier(request.id);
    identifier(request.action);
    if (request.version !== HOST_PROTOCOL_VERSION)
      throw Error("Unsupported host protocol");
    const stdout = await this.channel.run(
      host,
      Buffer.from(JSON.stringify(request)),
      [
        "sudo",
        "-n",
        "env",
        "-i",
        "PATH=/usr/bin:/bin",
        "python3",
        "-I",
        "/opt/jetski/host/control.py",
      ],
      signal,
    );
    try {
      const response = JSON.parse(stdout) as HostResponse;
      if (
        !response ||
        response.version !== HOST_PROTOCOL_VERSION ||
        response.id !== request.id ||
        !Object.hasOwn(response, "result")
      )
        throw Error("Invalid host response");
      return response;
    } catch {
      throw new HostTransportError(
        "Boat host control failed; remote completion unknown",
      );
    }
  }
}
