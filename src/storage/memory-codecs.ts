import type { MemoryChunkCodecAdapter } from "../core/memory-chunk-codec.js";

/** Web-stream implementation: no Node compression, filesystem or provider import.
 * Alternative implementations may tune compression without changing the format. */
async function transform(
  bytes: Uint8Array<ArrayBuffer>,
  stream: CompressionStream | DecompressionStream,
  maxBytes: number,
) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const pieces: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > maxBytes) throw Error("Memory codec output exceeds bound");
      pieces.push(part.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of pieces) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
export const gzipMemoryCodec: MemoryChunkCodecAdapter = {
  name: "gzip",
  encode(bytes) {
    return transform(bytes, new CompressionStream("gzip"), 8 * 1024 ** 2);
  },
  decode(bytes, maxBytes) {
    return transform(bytes, new DecompressionStream("gzip"), maxBytes);
  },
};
