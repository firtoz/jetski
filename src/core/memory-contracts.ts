import { identifier, type Json } from "./contracts.js";
import type { MemoryChunkCodec } from "./portable-memory-format.js";

export const MEMORY_RESTORE_CONCURRENCIES = [1, 2, 4] as const;
export type MemoryRestoreConcurrency =
  (typeof MEMORY_RESTORE_CONCURRENCIES)[number];
export function memoryRestoreConcurrency(
  value: number = 1,
): MemoryRestoreConcurrency {
  if (!(MEMORY_RESTORE_CONCURRENCIES as readonly number[]).includes(value))
    throw Error("Memory restore concurrency must be 1, 2 or 4");
  return value as MemoryRestoreConcurrency;
}

/** Local acceleration receipt; the independently retained FS root is authoritative. */
export type MemoryCheckpointReceipt = {
  checkpointId: string;
  filesystemSha256: string;
  sha256: string;
  memoryBytes: number;
};
export function memoryCheckpointReceipt(
  value: Json,
  checkpointId: string,
  filesystemSha256: string,
): MemoryCheckpointReceipt {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.phase !== "sealed" ||
    value.checkpointId !== checkpointId ||
    value.filesystemSha256 !== filesystemSha256 ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.memoryBytes !== "number" ||
    !Number.isSafeInteger(value.memoryBytes) ||
    value.memoryBytes < 0
  )
    throw Error("Memory seal unconfirmed");
  identifier(checkpointId);
  return {
    checkpointId,
    filesystemSha256,
    sha256: value.sha256,
    memoryBytes: value.memoryBytes,
  };
}

/** Observed on the assigned host; an unassigned sandbox has no runtime capability. */
export type SandboxRuntimeCapabilities = {
  runtimeKind: "podman" | "gvisor" | null;
  memorySuspendVersion: 1 | null;
  portableMemoryVersion: 1 | null;
};

/** Opt-in portable capture; codecs are supplied by the embedding platform. */
export type PortableMemoryOptions = {
  codec: MemoryChunkCodec;
  chunkBytes: number;
  reuse: boolean;
};
export function portableMemoryOptions(value: unknown): PortableMemoryOptions {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid portable memory options");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(",") !== "chunkBytes,codec,reuse" ||
    (v.codec !== "identity" && v.codec !== "gzip") ||
    typeof v.chunkBytes !== "number" ||
    !Number.isSafeInteger(v.chunkBytes) ||
    v.chunkBytes < 65536 ||
    v.chunkBytes > 4 * 1024 ** 2 ||
    typeof v.reuse !== "boolean"
  )
    throw Error("Invalid portable memory options");
  return { codec: v.codec, chunkBytes: v.chunkBytes, reuse: v.reuse };
}
