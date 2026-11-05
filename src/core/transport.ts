import type { CapturedArchive } from "./archive-format.js";
import type { ArchiveSource } from "./archive-source.js";
import type { Json } from "./contracts.js";
import type { CapturedMemory } from "./memory-capture.js";
import type { HostLease } from "./pool.js";
import type { WorkloadResources } from "./resources.js";
export type CachedResumeRequest = {
  lease: HostLease;
  image: string;
  checkpointId: string;
  sha256: string;
  bytes: number;
  resources: WorkloadResources;
};
export const HOST_PROTOCOL_VERSION = 1;
/** Raw parts are bounded independently of the control protocol envelope. */
export const HOST_IMPORT_FILE_BYTES = 16 * 1024 * 1024;
export type CheckpointImportSink = {
  chunkBytes: number;
  write(
    offset: number,
    bytes: Uint8Array<ArrayBuffer>,
    sha256: string,
  ): Promise<Json>;
  close(): Promise<void>;
};
/** Negotiated control chunks; ordinary control requests keep their smaller bound. */
export const HOST_IMPORT_CHUNK_BYTES = 4 * 1024 * 1024;
export function hostRequestByteLimit(action: string): number {
  return [
    "import-chunk",
    "memory-import-begin",
    "memory-import-chunk",
  ].includes(action)
    ? 6 * 1024 * 1024
    : 1024 * 1024;
}
/** Native export manifests may describe thousands of chunks; data reads retain
 * their existing independent bound. Only this private action gets more room. */
export function hostResponseByteLimit(action: string): number {
  return (action === "memory-export" ? 8 : 2) * 1024 * 1024;
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
export type MemoryImportSink = {
  chunkBytes: number;
  write(
    objectId: string,
    offset: number,
    bytes: Uint8Array<ArrayBuffer>,
    sha256: string,
  ): Promise<Json>;
  close(): Promise<void>;
};
export interface HostTransport {
  memorySource?(
    host: string,
    lease: HostLease,
    checkpointId: string,
    capture: CapturedMemory,
    image: string,
  ): Promise<ArchiveSource | undefined>;
  memoryImport?(
    host: string,
    lease: HostLease,
    checkpointId: string,
    image: string,
  ): Promise<MemoryImportSink | undefined>;

  /** Optional composition of fenced claim, verified cache import and create.
   * A miss must not create a runtime. The core validates the returned identity. */
  resumeCached?(host: string, input: CachedResumeRequest): Promise<Json>;
  /** Optional bounded binary import; durable offsets remain host-authoritative. */
  checkpointImport?(
    host: string,
    lease: HostLease,
    image: string,
  ): Promise<CheckpointImportSink>;

  /** Optional immutable binary binding. It cannot authorize checkpoint publication. */
  checkpointSource?(
    host: string,
    lease: HostLease,
    archive: CapturedArchive,
    image: string,
  ): Promise<ArchiveSource | undefined>;

  request(
    host: string,
    request: HostRequest,
    signal?: AbortSignal,
  ): Promise<HostResponse>;
}
/** Safe controller diagnostics: never include command text, stdout/stderr or credentials. */
export type HostTransportDetails = Readonly<{
  provider: string;
  code:
    | "transport"
    | "remote-exit"
    | "invalid-receipt"
    | "output-bound"
    | "deadline"
    | "aborted";
  exitCode?: number;
  httpStatus?: number;
}>;
/** Transport loss is uncertainty about a remote effect, never permission to retry.
 * Details classify observation; they are deliberately not a retryable flag.
 */
export class HostTransportError extends Error {
  readonly uncertain = true;
  readonly details: HostTransportDetails | undefined;
  constructor(message: string, details?: HostTransportDetails) {
    super(message);
    this.name = "HostTransportError";
    this.details = details ? Object.freeze({ ...details }) : undefined;
  }
}
