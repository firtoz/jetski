export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

/** Transactions must be serializable and durably committed before resolving.
 * Callbacks are synchronous: never hold a transaction across external I/O. */
export interface Transaction {
  get<T extends Json>(key: string): T | undefined;
  put(key: string, value: Json): void;
  delete(key: string): void;
  scan<T extends Json>(prefix: string): Array<{ key: string; value: T }>;
}
export interface StateStore {
  transaction<T>(body: (tx: Transaction) => T): Promise<T>;
}
export type Scope = { owner: string; sandbox: string };
export type Fence = Scope & { generation: number };
/** Format acceptance is independent of current capture tuning. */
export const CHECKPOINT_FORMAT = Object.freeze({
  maxExpandedFrameBytes: 4 * 1024 * 1024,
  maxFrames: 8192,
});
export const CAPTURE_FRAME_BYTES = [
  256 * 1024,
  512 * 1024,
  1024 * 1024,
] as const;
export const DEFAULTS = Object.freeze({
  idleMs: 10 * 60_000,
  hostLifetimeMs: 60 * 60_000,
  hostDrainMs: 5 * 60_000,
  hostsPerOwner: 1,
  gcGraceMs: 24 * 60 * 60_000,
  gcInventoryObjects: 100_000,
  gcInventoryPageObjects: 64,
  frameBytes: 1024 * 1024,
  verificationConcurrency: 4,
  transferConcurrency: 2,
  maxTransferConcurrency: 4,
  maxObjectBytes: 8 * 1024 * 1024,
  outputChannelBytes: 16 * 1024 * 1024,
  outputChunkBytes: 256 * 1024,
  outputJournalParts: 130,
  maxInlineOutputBytes: 8192,
  commandStartWaitMs: 250,
  maxCommandStartWaitMs: 1000,
});

export function identifier(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new Error("Invalid identifier");
  return value;
}
export function scopeKey(scope: Scope): string {
  return `${identifier(scope.owner)}/${identifier(scope.sandbox)}`;
}
export function canonical(value: Json): string {
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("Non-finite JSON number");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key] as Json)}`)
    .join(",")}}`;
}
export type ObjectAddress = Scope & { id: string };
export type ObjectInfo = ObjectAddress & { bytes: number; sha256: string };
export type ObjectRange = {
  start: number;
  endExclusive: number;
  sha256: string;
};
export type ObjectWriteMetadata = {
  bytes: number;
  sha256: string;
  /** Optional readback-cache hint. Publication must still verify the ranges;
   * adapters without this optimization may ignore the hint. */
  ranges?: readonly ObjectRange[];
};
export type ByteStream = AsyncIterable<Uint8Array>;
export interface CheckpointStore {
  /** Opt-in bound for overlapping independent object verification calls (1..4). Omission is serial. */
  readonly verificationConcurrency?: number;
  /** Opt into independent uploads, bounded to four; omitted means serial. */
  readonly transferConcurrency?: number;
  /** Create-only. Never replace a physical object identity, even after deletion. */
  put(
    address: ObjectAddress,
    source: ByteStream,
    expected: ObjectWriteMetadata,
  ): Promise<ObjectInfo>;
  /** Optional bounded-buffer upload. The caller keeps bytes unchanged until this
   * promise settles; implementations must enforce the same complete integrity and
   * immutable-identity contract as put. Missing support uses the streaming path. */
  putBuffer?(
    address: ObjectAddress,
    bytes: Uint8Array<ArrayBuffer>,
    expected: ObjectWriteMetadata,
  ): Promise<ObjectInfo>;
  head(address: ObjectAddress): Promise<ObjectInfo | undefined>;
  /** Optional whole-object plus slice-hash proof. Missing support uses bounded
   * core readback; implementations must not trust unverified range metadata. */
  verifyRanges?(
    address: ObjectAddress,
    ranges: readonly ObjectRange[],
  ): Promise<ObjectInfo | undefined>;
  read(
    address: ObjectAddress,
    range?: { start: number; endExclusive: number },
  ): ByteStream;
  /** Complete listing is required before any collection decision. */
  list(scope: Scope): AsyncIterable<ObjectInfo>;
  delete(address: ObjectAddress): Promise<void>;
}
export type OperationPhase =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "uncertain";
export type Operation = {
  id: string;
  owner: string;
  sandbox: string;
  kind: string;
  input: Json;
  phase: OperationPhase;
  generation: number;
  createdAt: number;
  updatedAt: number;
  result: Json;
  error: string | null;
};
export interface Scheduler {
  schedule(scope: Scope, at: number): Promise<void>;
}
export interface EventSink {
  emit(event: { type: string; scope: Scope; at: number; details: Json }): void;
}
export type HostCapabilities = {
  kind: "machine-host";
  architecture: "x86_64";
  rootlessPodman: boolean;
  /** Absence retains the original one-hour allocation contract. */
  maxLifetimeMs?: number;
};
export interface HostProvider {
  capabilities(): HostCapabilities;
  allocate(input: {
    owner: string;
    operationId: string;
    expiresAt: number;
  }): Promise<{ id: string; allocationId: string }>;
  inspect(
    id: string,
  ): Promise<{ state: "ready" | "starting" | "absent" | "unknown" }>;
  retire(id: string, allocationId: string): Promise<void>;
}

/** Operator policy; workload requests cannot select host networking. */
export const RUNTIME_NETWORK_MODES = [
  "none",
  "egress",
  "public-egress",
] as const;
export type RuntimeNetworkMode = (typeof RUNTIME_NETWORK_MODES)[number];

/** Trusted bootstrap choice; never switched on an existing runtime store. */
export const RUNTIME_STORAGE_MODES = ["default", "fuse-overlayfs"] as const;
export type RuntimeStorageMode = (typeof RUNTIME_STORAGE_MODES)[number];
