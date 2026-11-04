import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  decodeMemoryChunk,
  encodeMemoryChunk,
  identityMemoryCodec,
} from "../src/core/memory-chunk-codec.js";
import { gzipMemoryCodec } from "../src/storage/memory-codecs.js";

const scope = { owner: "owner", sandbox: "sandbox", id: "attempt" };
for (const codec of [identityMemoryCodec, gzipMemoryCodec])
  test(`memory ${codec.name} round trip, immutable identity and corruption refusal`, async () => {
    const original = randomBytes(65536),
      result = await encodeMemoryChunk(scope, 0, original, codec);
    assert.deepEqual(
      Buffer.from(await decodeMemoryChunk(result.chunk, result.encoded, codec)),
      original,
    );
    const same = await encodeMemoryChunk(
      { ...scope, id: "another-attempt" },
      65536,
      original,
      codec,
    );
    assert.equal(same.chunk.object.sha256, result.chunk.object.sha256);
    assert.notEqual(same.chunk.object.id, result.chunk.object.id);
    original.fill(0);
    assert.notDeepEqual(
      Buffer.from(await decodeMemoryChunk(result.chunk, result.encoded, codec)),
      original,
    );
    const damaged = result.encoded.slice();
    damaged[0]! ^= 1;
    await assert.rejects(
      decodeMemoryChunk(result.chunk, damaged, codec),
      /checksum/,
    );
    await assert.rejects(
      decodeMemoryChunk(result.chunk, result.encoded.subarray(1), codec),
      /stored/,
    );
    const changed = structuredClone(result.chunk);
    changed.sha256 = "0".repeat(64);
    await assert.rejects(
      decodeMemoryChunk(changed, result.encoded, codec),
      /checksum/,
    );
  });
test("bounded gzip decoder rejects expansion beyond the manifest before returning bytes", async () => {
  const encoded = await gzipMemoryCodec.encode(new Uint8Array(1024 * 1024));
  await assert.rejects(gzipMemoryCodec.decode(encoded, 128), /bound/);
});
test("replaceable encoders cannot publish a lossy result", async () => {
  await assert.rejects(
    encodeMemoryChunk(scope, 0, new Uint8Array([1, 2, 3]), {
      name: "gzip",
      encode: async (b) => b,
      decode: async () => new Uint8Array([1, 2, 4]),
    }),
    /round trip/,
  );
});
