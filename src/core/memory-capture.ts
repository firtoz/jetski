import { type Fence, identifier, type Json } from "./contracts.js";
import {
  type MemoryChunkCodec,
  type PortableMemoryCompatibility,
  type PortableMemoryManifest,
  parsePortableMemory,
} from "./portable-memory-format.js";

export type CapturedMemoryChunk = {
  offset: number;
  bytes: number;
  sha256: string;
  codec: MemoryChunkCodec;
  packedOffset: number;
  storedBytes: number;
  storedSha256: string;
};
export type CapturedMemory = {
  version: 1;
  bytes: number;
  sha256: string;
  expandedBytes: number;
  compatibility: PortableMemoryCompatibility;
  directories: string[];
  files: {
    path: string;
    bytes: number;
    sha256: string;
    chunks: CapturedMemoryChunk[];
  }[];
};
function fields(
  value: unknown,
  expected: string,
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== expected
  )
    throw Error("Invalid memory capture fields");
}
export function memoryCaptureManifest(
  fence: Fence,
  id: string,
  filesystemSha256: string,
  capture: CapturedMemory,
): PortableMemoryManifest {
  return parsePortableMemory(
    {
      owner: fence.owner,
      sandbox: fence.sandbox,
      generation: fence.generation,
      kind: "portable-memory",
      version: 1,
      checkpointId: id,
      filesystemSha256,
      compatibility: capture.compatibility,
      directories: capture.directories,
      files: capture.files.map((file, fi) => ({
        ...file,
        chunks: file.chunks.map((c, ci) => ({
          offset: c.offset,
          bytes: c.bytes,
          sha256: c.sha256,
          codec: c.codec,
          object: {
            owner: fence.owner,
            sandbox: fence.sandbox,
            id: `capture-${fi}-${ci}`,
            bytes: c.storedBytes,
            sha256: c.storedSha256,
          },
        })),
      })),
    },
    fence,
  );
}
/** Validate both the native file layout and the complete encoded-pack partition.
 * Lexical file order need not equal physical order; transport reads use offsets. */
export function parseMemoryCapture(
  value: unknown,
  fence: Fence,
  id: string,
  filesystemSha256: string,
): CapturedMemory {
  identifier(id);
  fields(
    value,
    "bytes,compatibility,directories,expandedBytes,files,sha256,version",
  );
  if (
    value.version !== 1 ||
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > 16 * 1024 ** 3 ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.expandedBytes !== "number" ||
    !Number.isSafeInteger(value.expandedBytes) ||
    !Array.isArray(value.files) ||
    value.files.length > 256
  )
    throw Error("Invalid memory capture");
  const extents: { offset: number; bytes: number }[] = [];
  let expanded = 0,
    chunks = 0;
  for (const file of value.files) {
    fields(file, "bytes,chunks,path,sha256");
    if (!Array.isArray(file.chunks) || file.chunks.length > 8192)
      throw Error("Memory capture chunk bound");
    for (const c of file.chunks) {
      if (++chunks > 8192) throw Error("Memory capture chunk bound");
      fields(
        c,
        "bytes,codec,offset,packedOffset,sha256,storedBytes,storedSha256",
      );
      if (
        typeof c.packedOffset !== "number" ||
        !Number.isSafeInteger(c.packedOffset) ||
        c.packedOffset < 0 ||
        typeof c.storedBytes !== "number" ||
        !Number.isSafeInteger(c.storedBytes) ||
        c.storedBytes < 1
      )
        throw Error("Invalid memory pack extent");
      extents.push({ offset: c.packedOffset, bytes: c.storedBytes });
    }
    if (typeof file.bytes !== "number")
      throw Error("Invalid memory file length");
    expanded += file.bytes;
  }
  extents.sort((a, b) => a.offset - b.offset);
  let offset = 0;
  for (const extent of extents) {
    if (extent.offset !== offset) throw Error("Memory pack gap or overlap");
    offset += extent.bytes;
  }
  if (offset !== value.bytes || expanded !== value.expandedBytes)
    throw Error("Memory capture size mismatch");
  const capture = structuredClone(value) as unknown as CapturedMemory;
  memoryCaptureManifest(fence, id, filesystemSha256, capture);
  return capture;
}
export function memoryCaptureJson(value: CapturedMemory): Json {
  return value as unknown as Json;
}
