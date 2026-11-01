import type { Json } from "./contracts.js";
export const HOST_PROTOCOL_VERSION = 1;
/** The larger envelope is reserved for negotiated checkpoint chunks. Ordinary
 * control requests retain their existing bound. */
export const HOST_IMPORT_CHUNK_BYTES = 4 * 1024 * 1024;
export function hostRequestByteLimit(action: string): number {
  return action === "import-chunk" ? 6 * 1024 * 1024 : 1024 * 1024;
}
/** Leave room for two bounded 120-second runtime calls plus receipt/cleanup I/O.
 * A shorter outer deadline can terminate control before its outcome is recorded.
 * Expiry still means uncertainty, never permission to replay remote work. */
export const HOST_CONTROL_TIMEOUT_MS = 300_000;
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
