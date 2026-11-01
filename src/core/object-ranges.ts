import {
  CHECKPOINT_FORMAT,
  type CheckpointStore,
  DEFAULTS,
  identifier,
  type ObjectInfo,
  type ObjectRange,
} from "./contracts.js";
import { sameObject } from "./inventory.js";

/** Snapshot expectations before adapter I/O and reject ambiguous range claims. */
export function objectRanges(
  input: readonly ObjectRange[],
  bytes = DEFAULTS.maxObjectBytes,
): ObjectRange[] {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > DEFAULTS.maxObjectBytes
  )
    throw Error("Invalid object proof size");
  if (
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > CHECKPOINT_FORMAT.maxFrames
  )
    throw Error("Invalid object range count");
  const seen = new Map<string, string>();
  const ranges: ObjectRange[] = [];
  for (const range of input) {
    if (
      !range ||
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.endExclusive) ||
      range.start < 0 ||
      range.endExclusive <= range.start ||
      range.endExclusive > bytes ||
      typeof range.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(range.sha256)
    )
      throw Error("Invalid object verification range");
    const key = `${range.start}/${range.endExclusive}`;
    const previous = seen.get(key);
    if (previous && previous !== range.sha256)
      throw Error("Conflicting object range proof");
    if (!previous) {
      ranges.push({
        start: range.start,
        endExclusive: range.endExclusive,
        sha256: range.sha256,
      });
      seen.set(key, range.sha256);
    }
  }
  return ranges;
}

async function sha(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function wholeObjectProof(
  object: ObjectInfo,
  ranges: readonly ObjectRange[],
): boolean {
  return (
    ranges.length > 0 &&
    ranges.every(
      (range) =>
        range.start === 0 &&
        range.endExclusive === object.bytes &&
        range.sha256 === object.sha256,
    )
  );
}

/** A pack hash cannot prove a logical slice hash. Every adapter must either
 * verify both or use this bounded portable fallback before publication. */
export async function verifyObjectRanges(
  store: CheckpointStore,
  object: ObjectInfo,
  input: readonly ObjectRange[],
): Promise<void> {
  const expected = { ...object };
  for (const value of [expected.owner, expected.sandbox, expected.id]) {
    if (typeof value !== "string") throw Error("Invalid object proof identity");
    identifier(value);
  }
  if (
    typeof expected.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(expected.sha256)
  )
    throw Error("Invalid object proof digest");
  if (
    !Number.isSafeInteger(expected.bytes) ||
    expected.bytes < 1 ||
    expected.bytes > DEFAULTS.maxObjectBytes
  )
    throw Error("Invalid object proof size");
  const ranges = objectRanges(input, expected.bytes);
  const address = {
    owner: expected.owner,
    sandbox: expected.sandbox,
    id: expected.id,
  };
  if (wholeObjectProof(expected, ranges)) {
    const verified = await store.head(address);
    if (!verified || !sameObject(verified, expected))
      throw Error("Object range integrity failure");
    return;
  }
  if (store.verifyRanges) {
    const verified = await store.verifyRanges(
      address,
      ranges.map((range) => ({ ...range })),
    );
    if (!verified || !sameObject(verified, expected))
      throw Error("Object range integrity failure");
    return;
  }
  const bytes = new Uint8Array(expected.bytes);
  let offset = 0;
  for await (const part of store.read(address)) {
    if (!(part instanceof Uint8Array) || offset + part.length > bytes.length)
      throw Error("Object range read overflow");
    bytes.set(part, offset);
    offset += part.length;
  }
  if (offset !== bytes.length || (await sha(bytes)) !== expected.sha256)
    throw Error("Object range integrity failure");
  for (const range of ranges)
    if (
      (await sha(bytes.subarray(range.start, range.endExclusive))) !==
      range.sha256
    )
      throw Error("Object slice integrity failure");
}
