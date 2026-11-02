import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  type R2BucketPort,
  R2CheckpointStore,
  type R2ObjectMetadata,
  type R2WriteVerification,
} from "../src/storage/r2.js";
import { qualifyStorage } from "../src/testing/storage.js";

const sha = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const checksum = (value: Uint8Array) =>
  Uint8Array.from(Buffer.from(sha(value), "hex")).buffer;
function fixture() {
  const objects = new Map<
    string,
    {
      bytes: Uint8Array;
      metadata: Record<string, string>;
      version: string;
      checksum: ArrayBuffer;
    }
  >();
  let serial = 0,
    lost = false;
  let receipt:
    | "valid"
    | "missing"
    | "wrong"
    | "missing-version"
    | "wrong-key"
    | "malformed" = "valid";
  let omitObservationChecksum = false;
  let conditionalWait: Promise<void> | undefined;
  const metrics = { gets: 0, bodies: 0 };
  const meta = (
    key: string,
    row: NonNullable<ReturnType<typeof objects.get>>,
  ): R2ObjectMetadata => ({
    key,
    size: row.bytes.length,
    etag: sha(row.bytes),
    version: row.version,
    customMetadata: row.metadata,
    ...(!omitObservationChecksum
      ? { checksums: { sha256: row.checksum } }
      : {}),
  });
  const bucket: R2BucketPort = {
    async put(key, value, options) {
      assert.deepEqual(options?.onlyIf, { etagDoesNotMatch: "*" });
      if (objects.has(key)) return null;
      if (
        options?.sha256 &&
        Buffer.from(options.sha256).toString("hex") !== sha(value)
      )
        throw Error("server checksum mismatch");
      const row = {
        bytes: Uint8Array.from(value),
        metadata: options?.customMetadata ?? {},
        version: `version-${++serial}`,
        checksum: checksum(value),
      };
      objects.set(key, row);
      if (lost && key.includes("/objects/")) {
        lost = false;
        throw Error("lost PUT acknowledgement");
      }
      const result = meta(key, row);
      if (receipt === "missing") delete result.checksums;
      if (receipt === "malformed")
        result.checksums = { sha256: new ArrayBuffer(31) };
      if (receipt === "wrong")
        result.checksums = { sha256: new ArrayBuffer(32) };
      if (receipt === "missing-version") delete result.version;
      if (receipt === "wrong-key") result.key = "another-key";
      return result;
    },
    async get(key, options) {
      metrics.gets++;
      const row = objects.get(key);
      if (!row) return null;
      const result = meta(key, row);
      if (options?.onlyIf?.etagDoesNotMatch === result.etag) {
        await conditionalWait;
        return result;
      }
      metrics.bodies++;
      const bytes = Uint8Array.from(row.bytes);
      return {
        ...result,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(bytes.subarray(0, 1));
            c.enqueue(bytes.subarray(1));
            c.close();
          },
        }),
      };
    },
    async list(options) {
      const keys = [...objects.keys()]
        .filter((k) => k.startsWith(options.prefix))
        .sort();
      const offset = Number(options.cursor ?? "0"),
        selected = keys.slice(offset, offset + 2);
      return {
        objects: selected.map((key) => ({
          key,
          size: objects.get(key)!.bytes.length,
        })),
        truncated: offset + 2 < keys.length,
        cursor: String(offset + 2),
        delimitedPrefixes: [],
      };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
  return {
    bucket,
    objects,
    metrics,
    holdConditional: (wait: Promise<void>) => {
      conditionalWait = wait;
    },
    open: (writeVerification: R2WriteVerification = "readback") =>
      new R2CheckpointStore(bucket, "fixture/v1", { writeVerification }),
    receipt: (mode: typeof receipt) => {
      receipt = mode;
    },
    omitChecksum: () => {
      omitObservationChecksum = true;
    },
    loseAck: () => {
      lost = true;
    },
  };
}
const address = { owner: "owner", sandbox: "sandbox", id: "object" };
const bytes = Buffer.from("independent bytes and ranges");
const expected = {
  bytes: bytes.length,
  sha256: sha(bytes),
  ranges: [{ start: 3, endExclusive: 17, sha256: sha(bytes.subarray(3, 17)) }],
};
async function* source() {
  yield bytes.subarray(0, 2);
  yield bytes.subarray(2);
}

for (const mode of ["readback", "provider-sha256"] as const)
  test(`native R2 ${mode} passes storage consistency and recovery contract`, async () => {
    const f = fixture();
    const report = await qualifyStorage(async () => ({
      store: f.open(mode),
      close: () => {},
    }));
    assert.equal(report.passed, true);
    assert.equal(report.cleanup.complete, true);
    assert.ok([...f.objects.keys()].every((k) => k.includes("/reservations/")));
  });

test("provider write proofs require exact checksum/version and a fresh publication observation", async () => {
  const f = fixture(),
    store = f.open("provider-sha256");
  await store.put(address, source(), expected);
  assert.equal(f.metrics.gets, 0);
  assert.deepEqual(await store.verifyRanges(address, expected.ranges), {
    ...address,
    bytes: expected.bytes,
    sha256: expected.sha256,
  });
  assert.equal(f.metrics.gets, 1);
  assert.equal(f.metrics.bodies, 0);
  const row = f.objects.get("fixture/v1/owner/sandbox/objects/object")!;
  row.version = "different-upload-same-bytes";
  await assert.rejects(store.head(address), /invalidated/);
});

test("missing capability falls back to complete readback; malformed or conflicting checksums fail closed", async () => {
  for (const mode of ["missing", "missing-version"] as const) {
    const f = fixture();
    f.receipt(mode);
    await f.open("provider-sha256").put(address, source(), expected);
    assert.equal(f.metrics.bodies, 1);
  }
  for (const mode of ["wrong", "wrong-key", "malformed"] as const) {
    const f = fixture();
    f.receipt(mode);
    await assert.rejects(
      f.open("provider-sha256").put(address, source(), expected),
      /receipt/,
    );
  }
  const f = fixture(),
    store = f.open("provider-sha256");
  await store.put(address, source(), expected);
  f.omitChecksum();
  await store.verifyRanges(address, expected.ranges);
  assert.equal(f.metrics.bodies, 1);
});

test("lost write acknowledgements, changed bytes, and false logical hashes never become successful reuse", async () => {
  const f = fixture();
  f.loseAck();
  await assert.rejects(
    f.open("provider-sha256").put(address, source(), expected),
    /lost PUT/,
  );
  assert.deepEqual(await f.open("provider-sha256").head(address), {
    ...address,
    bytes: expected.bytes,
    sha256: expected.sha256,
  });
  await assert.rejects(f.open().put(address, source(), expected), /reserved/);
  const row = f.objects.get("fixture/v1/owner/sandbox/objects/object")!;
  row.bytes[0] = 99;
  await assert.rejects(f.open("provider-sha256").head(address), /integrity/);
  const g = fixture();
  await assert.rejects(
    g.open("provider-sha256").put(address, source(), {
      ...expected,
      ranges: [{ ...expected.ranges[0]!, sha256: "0".repeat(64) }],
    }),
    /slice integrity/,
  );
  assert.ok([...g.objects.keys()].every((k) => k.includes("/reservations/")));
});

test("core publication freshly observes provider proofs before acknowledging a packed root", async () => {
  const { gzipSync } = await import("node:zlib");
  const { SqliteState } = await import("../src/state/sqlite.js");
  const { CheckpointRegistry } = await import("../src/core/checkpoints.js");
  const { CheckpointTransfer } = await import("../src/core/transfer.js");
  const f = fixture(),
    store = f.open("provider-sha256"),
    state = new SqliteState(":memory:");
  try {
    const registry = new CheckpointRegistry(state, store),
      fence = { owner: "owner", sandbox: "sandbox", generation: 1 };
    await registry.initialize(fence);
    const raw = [
        Buffer.from("one exact member"),
        Buffer.from("another exact member"),
      ],
      parts = raw.map((p) => gzipSync(p)),
      encoded = Buffer.concat(parts);
    let offset = 0;
    const archive = {
      version: 1 as const,
      sha256: sha(encoded),
      bytes: encoded.length,
      expandedBytes: raw.reduce((n, p) => n + p.length, 0),
      entries: 2,
      frames: parts.map((p, i) => {
        const frame = {
          offset,
          bytes: p.length,
          sha256: sha(p),
          expandedBytes: raw[i]!.length,
          expandedSha256: sha(raw[i]!),
        };
        offset += p.length;
        return frame;
      }),
    };
    const transfer = new CheckpointTransfer(store, registry, undefined, {
      packBytes: 1024,
    });
    const saved = await transfer.save(fence, "save", archive, {
      read: async (start, count) => encoded.subarray(start, start + count),
    });
    assert.equal(saved.root.id, "save");
    assert.equal(f.metrics.gets, 1);
    assert.equal(f.metrics.bodies, 0);
    assert.equal(saved.root.retiredAt, null);
  } finally {
    state.close();
  }
});

test("a delayed conditional reply cannot revive a deleted proof", async () => {
  const f = fixture(),
    store = f.open("provider-sha256");
  await store.put(address, source(), expected);
  let release!: () => void;
  f.holdConditional(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const observed = store.head(address);
  assert.equal(f.metrics.gets, 1);
  await store.delete(address);
  release();
  await assert.rejects(observed, /invalidated/);
  assert.equal(await store.head(address), undefined);
});

test("dense packed ranges retain verified-write proofs without another payload download", async () => {
  const f = fixture(),
    store = f.open("provider-sha256");
  const body = Buffer.alloc(513, 42);
  const ranges = Array.from(body, (_, start) => ({
    start,
    endExclusive: start + 1,
    sha256: sha(body.subarray(start, start + 1)),
  }));
  await store.put(
    address,
    (async function* () {
      yield body;
    })(),
    {
      bytes: body.length,
      sha256: sha(body),
      ranges,
    },
  );
  await store.verifyRanges(address, ranges);
  assert.deepEqual(f.metrics, { gets: 1, bodies: 0 });
  await assert.rejects(
    store.verifyRanges(address, [{ ...ranges[0]!, sha256: "0".repeat(64) }]),
    /slice integrity/,
  );
});

test("the aggregate range-proof budget evicts old proofs with safe readback fallback", async () => {
  const f = fixture(),
    store = f.open("provider-sha256");
  const body = Buffer.alloc(8192, 42);
  const digest = sha(body.subarray(0, 1));
  const ranges = Array.from(body, (_, start) => ({
    start,
    endExclusive: start + 1,
    sha256: digest,
  }));
  const addresses = ["first", "second", "third"].map((id) => ({
    ...address,
    id,
  }));
  for (const object of addresses) {
    await store.put(
      object,
      (async function* () {
        yield body;
      })(),
      {
        bytes: body.length,
        sha256: sha(body),
        ranges,
      },
    );
  }
  await store.verifyRanges(addresses[2]!, ranges);
  assert.deepEqual(f.metrics, { gets: 1, bodies: 0 });
  await store.verifyRanges(addresses[0]!, ranges);
  assert.deepEqual(f.metrics, { gets: 2, bodies: 1 });
  await store.verifyRanges(addresses[2]!, ranges);
  assert.deepEqual(f.metrics, { gets: 3, bodies: 1 });
});

test("explicit buffer uploads borrow only for validated native writes; stream inputs remain copy-safe", async () => {
  for (const mode of ["readback", "provider-sha256"] as const) {
    const f = fixture(),
      store = f.open(mode),
      body = Buffer.from(bytes);
    const nativePut = f.bucket.put.bind(f.bucket);
    let uploaded: Uint8Array | undefined;
    f.bucket.put = async (key, value, options) => {
      if (key.includes("/objects/")) uploaded = value;
      return nativePut(key, value, options);
    };
    await store.putBuffer(address, body, expected);
    assert.equal(uploaded === body, mode === "provider-sha256");
    assert.equal(store.transferConcurrency, mode === "provider-sha256" ? 4 : 2);
    const mutable = Buffer.from(bytes);
    await store.put(
      { ...address, id: "stream" },
      (async function* () {
        yield mutable;
        mutable[0] = mutable[0]! ^ 255;
      })(),
      expected,
    );
    assert.notEqual(uploaded, mutable);
    assert.deepEqual(
      f.objects.get("fixture/v1/owner/sandbox/objects/stream")!.bytes,
      Uint8Array.from(bytes),
    );
  }
});

test("a changed borrowed buffer cannot receive a verified native-write acknowledgement", async () => {
  const f = fixture(),
    store = f.open("provider-sha256"),
    body = Buffer.from(bytes);
  const nativePut = f.bucket.put.bind(f.bucket);
  f.bucket.put = async (key, value, options) => {
    if (key.includes("/objects/")) value[0] = value[0]! ^ 255;
    return nativePut(key, value, options);
  };
  await assert.rejects(
    store.putBuffer(address, body, expected),
    /server checksum mismatch/,
  );
  assert.equal(await store.head(address), undefined);
  assert.ok(f.objects.has("fixture/v1/owner/sandbox/reservations/object"));
});
