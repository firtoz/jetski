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
export const DEFAULTS = Object.freeze({
  idleMs: 10 * 60_000,
  hostLifetimeMs: 60 * 60_000,
  hostDrainMs: 5 * 60_000,
  hostsPerOwner: 1,
  gcGraceMs: 24 * 60 * 60_000,
  gcInventoryObjects: 100_000,
  gcInventoryPageObjects: 64,
  frameBytes: 4 * 1024 * 1024,
  verificationConcurrency: 4,
  maxObjectBytes: 8 * 1024 * 1024,
  outputChannelBytes: 16 * 1024 * 1024,
  outputChunkBytes: 256 * 1024,
  outputJournalParts: 130,
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
export type ByteStream = AsyncIterable<Uint8Array>;
export interface CheckpointStore {
  /** Opt-in bound for overlapping independent head calls (1..4). Omission is serial. */
  readonly verificationConcurrency?: number;
  /** Create-only. Never replace a physical object identity, even after deletion. */
  put(
    address: ObjectAddress,
    source: ByteStream,
    expected: { bytes: number; sha256: string },
  ): Promise<ObjectInfo>;
  head(address: ObjectAddress): Promise<ObjectInfo | undefined>;
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
export const RUNTIME_NETWORK_MODES = ["none", "egress"] as const;
export type RuntimeNetworkMode = (typeof RUNTIME_NETWORK_MODES)[number];

/** Trusted bootstrap choice; never switched on an existing runtime store. */
export const RUNTIME_STORAGE_MODES = ["default", "fuse-overlayfs"] as const;
export type RuntimeStorageMode = (typeof RUNTIME_STORAGE_MODES)[number];
