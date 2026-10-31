import type { Json } from "./contracts.js";
export const HOST_PROTOCOL_VERSION = 1;
export type HostRequest = {
  version: typeof HOST_PROTOCOL_VERSION;
  id: string;
  action: string;
  payload: Json;
};
export type HostResponse = {
  version: typeof HOST_PROTOCOL_VERSION;
  id: string;
  result: Json;
};
export interface HostTransport {
  request(
    host: string,
    request: HostRequest,
    signal?: AbortSignal,
  ): Promise<HostResponse>;
}
/** Transport loss is uncertainty about a remote effect, never permission to retry. */
export class HostTransportError extends Error {
  readonly uncertain = true;
}
