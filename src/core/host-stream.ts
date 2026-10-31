import type { ByteStream } from "./contracts.js";
import type { HostLease } from "./pool.js";

export type HostStreamRequest = {
  streamId: string;
  lease: HostLease;
  image: string;
  port: number;
};
/** One connection, never reconnected/replayed. Consume output exactly once.
 * send accepts at most 16KiB and must be awaited before another send/end.
 * completed requires both half-closes and authenticated host success, not EOF.
 * abort closes transport; inspect the durable host receipt for cleanup status. */
export interface HostConnection {
  output: ByteStream;
  send(bytes: Uint8Array): Promise<void>;
  end(): Promise<void>;
  abort(): void;
  completed: Promise<void>;
}
export interface HostStreamTransport {
  open(
    host: string,
    request: HostStreamRequest,
    signal?: AbortSignal,
  ): Promise<HostConnection>;
}
