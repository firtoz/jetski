import type { ObjectAddress } from "./contracts.js";
import { identifier } from "./contracts.js";
import {
  type MemoryChunkCodec,
  PORTABLE_MEMORY_FORMAT,
  type PortableMemoryChunk,
} from "./portable-memory-format.js";

/** Trusted codec implementation; decoding must stop at the supplied output bound.
 * Core independently verifies both encoded and decoded identities. */
export interface MemoryChunkCodecAdapter {
  readonly name: MemoryChunkCodec;
  encode(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>>;
  decode(
    bytes: Uint8Array<ArrayBuffer>,
    maxBytes: number,
  ): Promise<Uint8Array<ArrayBuffer>>;
}
const hexDigest = async (bytes: Uint8Array<ArrayBuffer>) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

export const identityMemoryCodec: MemoryChunkCodecAdapter = {
  name: "identity",
  async encode(bytes) {
    return bytes.slice();
  },
  async decode(bytes, maxBytes) {
    if (bytes.length > maxBytes) throw Error("Memory decode exceeds bound");
    return bytes.slice();
  },
};

/** Produces immutable object metadata, not a publication acknowledgement. Object
 * addresses stay within the caller scope; reuse still requires retained-root and
 * complete remote verification under a live writer admission. The address must
 * come from a persisted upload attempt; content hashes index reuse, not permanent
 * object names (a failed create-only write can reserve its name forever). */
export async function encodeMemoryChunk(
  address: ObjectAddress,
  offset: number,
  input: Uint8Array,
  codec: MemoryChunkCodecAdapter,
): Promise<{ chunk: PortableMemoryChunk; encoded: Uint8Array<ArrayBuffer> }> {
  identifier(address.owner);
  identifier(address.sandbox);
  identifier(address.id);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > PORTABLE_MEMORY_FORMAT.maxBytes ||
    input.length < 1 ||
    input.length > PORTABLE_MEMORY_FORMAT.maxChunkBytes ||
    offset + input.length > PORTABLE_MEMORY_FORMAT.maxBytes ||
    (codec.name !== "identity" && codec.name !== "gzip")
  )
    throw Error("Invalid memory chunk input");
  const raw = new Uint8Array(input),
    sha256 = await hexDigest(raw);
  const encoded = new Uint8Array(await codec.encode(raw));
  if (
    encoded.length < 1 ||
    encoded.length > PORTABLE_MEMORY_FORMAT.maxStoredChunkBytes
  )
    throw Error("Encoded memory exceeds bound");
  // An encoder is replaceable, not authority for accepting data loss.
  const decoded = await codec.decode(encoded, raw.length);
  if (decoded.length !== raw.length || (await hexDigest(decoded)) !== sha256)
    throw Error("Memory codec failed round trip");
  const encodedSha256 = await hexDigest(encoded);
  if (
    codec.name === "identity" &&
    (encoded.length !== raw.length || encodedSha256 !== sha256)
  )
    throw Error("Identity memory codec changed bytes");
  return {
    chunk: {
      offset,
      bytes: raw.length,
      sha256,
      codec: codec.name,
      object: {
        owner: address.owner,
        sandbox: address.sandbox,
        id: address.id,
        bytes: encoded.length,
        sha256: encodedSha256,
      },
    },
    encoded,
  };
}

/** No reconstructed chunk reaches a native image until both byte identities
 * have been checked. Callers additionally verify the completed file digest. */
export async function decodeMemoryChunk(
  chunk: PortableMemoryChunk,
  input: Uint8Array,
  codec: MemoryChunkCodecAdapter,
): Promise<Uint8Array<ArrayBuffer>> {
  if (
    codec.name !== chunk.codec ||
    !Number.isSafeInteger(chunk.bytes) ||
    chunk.bytes < 1 ||
    chunk.bytes > PORTABLE_MEMORY_FORMAT.maxChunkBytes ||
    !Number.isSafeInteger(chunk.object.bytes) ||
    chunk.object.bytes < 1 ||
    chunk.object.bytes > PORTABLE_MEMORY_FORMAT.maxStoredChunkBytes ||
    input.length !== chunk.object.bytes
  )
    throw Error("Invalid stored memory chunk");
  const encoded = new Uint8Array(input);
  if ((await hexDigest(encoded)) !== chunk.object.sha256)
    throw Error("Stored memory chunk checksum mismatch");
  const decoded = new Uint8Array(await codec.decode(encoded, chunk.bytes));
  if (
    decoded.length !== chunk.bytes ||
    (await hexDigest(decoded)) !== chunk.sha256
  )
    throw Error("Decoded memory chunk checksum mismatch");
  return decoded;
}
