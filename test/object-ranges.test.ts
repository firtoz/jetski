import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { CheckpointStore, ObjectRange } from "../src/core/contracts.js";
import { objectRanges, verifyObjectRanges } from "../src/core/object-ranges.js";
import { S3CheckpointStore } from "../src/storage/s3.js";

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const address = { owner: "owner", sandbox: "sandbox", id: "object" };
const bytes = Buffer.from(
  Array.from({ length: 4096 }, (_, index) => index % 256),
);
const info = { ...address, bytes: bytes.length, sha256: sha(bytes) };
const range = (start: number, endExclusive: number): ObjectRange => ({
  start,
  endExclusive,
  sha256: sha(bytes.subarray(start, endExclusive)),
});
const ranges = [range(0, 1024), range(2048, 4096)];

function s3Fixture(cache = 1024) {
  let body: Buffer | undefined = bytes,
    tag = '"verified-1"',
    delivered = 0;
  let hold: (() => Promise<void>) | undefined;
  const calls: (string | undefined)[] = [];
  const client = {
    send: async (command: unknown) => {
      if (command instanceof DeleteObjectCommand) {
        body = undefined;
        return {};
      }
      assert.ok(command instanceof GetObjectCommand);
      const condition = command.input.IfNoneMatch;
      calls.push(condition);
      if (!body) throw Object.assign(Error("missing"), { name: "NoSuchKey" });
      if (condition === tag) {
        await hold?.();
        throw Object.assign(Error("unchanged"), {
          $metadata: { httpStatusCode: 304 },
        });
      }
      delivered += body.length;
      return {
        ContentLength: body.length,
        Metadata: {
          format: "jetski-object-v1",
          bytes: String(bytes.length),
          sha256: sha(bytes),
        },
        ETag: tag,
        Body: Readable.from([body]),
      };
    },
  } as unknown as Pick<S3Client, "send">;
  const store = new S3CheckpointStore(client, {
    bucket: "bucket",
    prefix: "ranges/v1",
    verifiedCacheEntries: cache,
  });
  return {
    store,
    calls,
    get delivered() {
      return delivered;
    },
    setBody(value: Buffer) {
      body = value;
      tag = '"changed"';
    },
    setTag(value: string) {
      tag = value;
    },
    hold(value: () => Promise<void>) {
      hold = value;
    },
  };
}

test("portable slice proof checks the physical object and every requested slice", async () => {
  let reads = 0,
    source = bytes;
  const store = {
    read: async function* () {
      reads++;
      yield source.subarray(0, 1000);
      yield source.subarray(1000);
    },
  } as unknown as CheckpointStore;
  await verifyObjectRanges(store, info, [...ranges, ranges[0]!]);
  assert.equal(reads, 1);
  await assert.rejects(
    verifyObjectRanges(store, info, [
      { ...ranges[0]!, sha256: "f".repeat(64) },
    ]),
    /slice integrity/,
  );
  source = Buffer.from(bytes);
  source[0] = source[0]! ^ 1;
  await assert.rejects(
    verifyObjectRanges(store, info, ranges),
    /range integrity/,
  );
  source = bytes.subarray(0, bytes.length - 1);
  await assert.rejects(
    verifyObjectRanges(store, info, ranges),
    /range integrity/,
  );
  source = Buffer.concat([bytes, Buffer.from([1])]);
  await assert.rejects(verifyObjectRanges(store, info, ranges), /overflow/);
  const before = reads;
  for (const invalid of [
    [{ ...ranges[0]!, start: -1 }],
    [{ ...ranges[0]!, endExclusive: bytes.length + 1 }],
    [ranges[0]!, { ...ranges[0]!, sha256: "0".repeat(64) }],
    [],
  ])
    await assert.rejects(verifyObjectRanges(store, info, invalid), /range/);
  assert.equal(reads, before, "invalid proof requests fail before adapter I/O");
});

test("S3 slice receipts require bytes once, conditional identity thereafter, and new bytes for unseen ranges", async () => {
  const f = s3Fixture();
  await verifyObjectRanges(f.store, info, ranges);
  assert.equal(f.delivered, bytes.length);
  assert.equal(f.calls[0], undefined);
  await verifyObjectRanges(f.store, info, ranges);
  assert.equal(
    f.delivered,
    bytes.length,
    "304 reuses derived slice hashes, never just metadata claims",
  );
  assert.equal(f.calls.at(-1), '"verified-1"');
  await verifyObjectRanges(f.store, info, [range(1024, 2048)]);
  assert.equal(
    f.delivered,
    2 * bytes.length,
    "unseen slice requires full verified bytes",
  );
  const wrong = [{ ...range(1024, 2048), sha256: "0".repeat(64) }];
  await assert.rejects(
    verifyObjectRanges(f.store, info, wrong),
    /slice integrity/,
  );
  f.setTag('"verified-2"');
  await verifyObjectRanges(f.store, info, ranges);
  const before = f.delivered;
  await verifyObjectRanges(f.store, info, ranges);
  assert.equal(
    f.delivered,
    before,
    "fresh ETag receipt is independently derived before reuse",
  );
  const corrupt = Buffer.from(bytes);
  corrupt[0] = corrupt[0]! ^ 1;
  f.setBody(corrupt);
  await assert.rejects(verifyObjectRanges(f.store, info, ranges), /integrity/);
});

test("range expectations are isolated and disabled or oversized proof caches remain correct", async () => {
  for (const cache of [0, 1]) {
    const f = s3Fixture(cache);
    const many = Array.from({ length: 129 }, (_, index) =>
      range(index, index + 1),
    );
    const source = structuredClone(many);
    await verifyObjectRanges(f.store, info, source);
    source[0]!.sha256 = "0".repeat(64);
    await verifyObjectRanges(f.store, info, many);
    assert.equal(
      f.delivered,
      2 * bytes.length,
      "oversized proofs never create unbounded receipts",
    );
  }
  const f = s3Fixture(0);
  await verifyObjectRanges(f.store, info, ranges);
  await verifyObjectRanges(f.store, info, ranges);
  assert.ok(f.calls.every((condition) => condition === undefined));
  const bad = {
    verifyRanges: async () => ({ ...info, id: "foreign" }),
  } as unknown as CheckpointStore;
  await assert.rejects(verifyObjectRanges(bad, info, ranges), /integrity/);
  const copy = objectRanges(ranges);
  copy[0]!.start = 99;
  assert.equal(ranges[0]!.start, 0);
});

test("S3 cannot reuse a slice receipt invalidated during a held conditional response", async () => {
  const f = s3Fixture();
  await verifyObjectRanges(f.store, info, ranges);
  let arrived!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.hold(async () => {
    arrived();
    await held;
  });
  const pending = verifyObjectRanges(f.store, info, ranges);
  const rejected = assert.rejects(pending, /invalidated/);
  await started;
  await f.store.delete(address);
  release();
  await rejected;
  assert.equal(await f.store.verifyRanges(address, ranges), undefined);
});
