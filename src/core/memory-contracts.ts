import { identifier, type Json } from "./contracts.js";

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
