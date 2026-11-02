import assert from "node:assert/strict";
import { test } from "node:test";
import {
  archiveChunks,
  MAX_CHECKPOINT_READ_BYTES,
} from "../src/core/archive-source.js";

test("negotiated source ranges preserve exact bytes and legacy bounds", async () => {
  const data = Uint8Array.from({ length: 1280 * 1024 + 73 }, (_, i) => i % 251);
  for (const chunkBytes of [undefined, MAX_CHECKPOINT_READ_BYTES]) {
    const calls: number[] = [],
      result: Uint8Array[] = [];
    for await (const part of archiveChunks(
      {
        readConcurrency: 4,
        readChunkBytes: chunkBytes,
        async read(offset, bytes) {
          calls.push(bytes);
          return data.slice(offset, offset + bytes);
        },
      },
      0,
      data.length,
      4,
    ))
      result.push(part);
    assert.deepEqual(Buffer.concat(result), Buffer.from(data));
    assert.equal(calls.length, chunkBytes === undefined ? 6 : 2);
    assert.ok(calls.every((bytes) => bytes <= (chunkBytes ?? 256 * 1024)));
  }
});

test("source range failures drain siblings and invalid negotiation never reads", async () => {
  for (const bytes of [0, -1, 1.5, MAX_CHECKPOINT_READ_BYTES + 1, Number.NaN]) {
    let reads = 0;
    await assert.rejects(async () => {
      for await (const _part of archiveChunks(
        {
          readChunkBytes: bytes,
          async read() {
            reads++;
            return new Uint8Array();
          },
        },
        0,
        1,
        1,
      )) {
      }
    }, /Invalid checkpoint read size/);
    assert.equal(reads, 0);
  }
  let release!: () => void,
    finished = false,
    reads = 0;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const consume = (async () => {
    for await (const _part of archiveChunks(
      {
        readConcurrency: 2,
        readChunkBytes: 1,
        async read(offset) {
          reads++;
          if (offset === 0) throw Error("failed range");
          await held;
          return Uint8Array.of(9);
        },
      },
      0,
      3,
      2,
    )) {
    }
  })().finally(() => {
    finished = true;
  });
  const rejected = assert.rejects(consume, /failed range/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(reads, 2);
  release();
  await rejected;
  assert.equal(reads, 2);
});
