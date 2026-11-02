import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { ObjectStreamVerifier } from "../src/storage/integrity.js";

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

test("stream proofs cover overlapping, adjacent and out-of-order ranges across chunk boundaries", () => {
  const bytes = randomBytes(16385);
  const ranges = [
    [8192, bytes.length],
    [13, 109],
    [0, 13],
    [8, 120],
    [13, 109],
  ].map(([start, endExclusive]) => ({
    start: start!,
    endExclusive: endExclusive!,
    sha256: sha(bytes.subarray(start, endExclusive)),
  }));
  for (const chunkBytes of [1, 7, 8192, bytes.length]) {
    const verifier = new ObjectStreamVerifier(
      { bytes: bytes.length, sha256: sha(bytes) },
      ranges,
    );
    for (let offset = 0; offset < bytes.length; offset += chunkBytes)
      verifier.update(bytes.subarray(offset, offset + chunkBytes));
    assert.deepEqual(
      [...verifier.finish()].sort(),
      [
        ...new Map(
          ranges.map((r) => [`${r.start}/${r.endExclusive}`, r.sha256]),
        ),
      ].sort(),
    );
    assert.throws(() => verifier.finish(), /already finished/);
    assert.throws(() => verifier.update(new Uint8Array()), /already finished/);
  }
});

test("whole-object and slice integrity remain independent and short or oversized streams fail", () => {
  const bytes = Buffer.from("unchanged range plus trailing bytes");
  const metadata = { bytes: bytes.length, sha256: sha(bytes) };
  const range = {
    start: 0,
    endExclusive: 9,
    sha256: sha(bytes.subarray(0, 9)),
  };
  const short = new ObjectStreamVerifier(metadata, [range]);
  short.update(bytes.subarray(0, 12));
  assert.throws(() => short.finish(), /integrity/);
  const oversized = new ObjectStreamVerifier(metadata);
  assert.throws(
    () => oversized.update(Buffer.concat([bytes, Buffer.from("extra")])),
    /declared length/,
  );
  assert.throws(() => oversized.finish(), /already finished/);
  const corrupt = new ObjectStreamVerifier(metadata, [range]);
  const changed = Buffer.from(bytes);
  changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
  corrupt.update(changed);
  assert.throws(() => corrupt.finish(), /integrity/);
  const falseSlice = new ObjectStreamVerifier(metadata, [
    { ...range, sha256: "0".repeat(64) },
  ]);
  assert.throws(() => falseSlice.update(bytes), /slice integrity/);
});

test("stream expectations are frozen and empty objects still require their exact digest", () => {
  const bytes = Buffer.from("immutable");
  const metadata = { bytes: bytes.length, sha256: sha(bytes) };
  const range = {
    start: 0,
    endExclusive: bytes.length,
    sha256: metadata.sha256,
  };
  const verifier = new ObjectStreamVerifier(metadata, [range]);
  metadata.sha256 = "0".repeat(64);
  range.sha256 = metadata.sha256;
  verifier.update(bytes);
  assert.equal(verifier.finish().get(`0/${bytes.length}`), sha(bytes));
  assert.equal(
    new ObjectStreamVerifier({
      bytes: 0,
      sha256: sha(new Uint8Array()),
    }).finish().size,
    0,
  );
  assert.throws(
    () =>
      new ObjectStreamVerifier({ bytes: 0, sha256: "0".repeat(64) }).finish(),
    /integrity/,
  );
  assert.throws(
    () =>
      new ObjectStreamVerifier({ bytes: 1, sha256: sha(bytes) }, [
        { start: 0, endExclusive: 1, sha256: "0".repeat(64) },
        { start: 0, endExclusive: 1, sha256: "1".repeat(64) },
      ]),
    /Conflicting/,
  );
});
