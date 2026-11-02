import { createHash, type Hash } from "node:crypto";
import { DEFAULTS, type ObjectRange } from "../core/contracts.js";
import { objectRanges } from "../core/object-ranges.js";

/** Node-compatible storage adapters can verify a readback without retaining its
 * body. Full-object and logical-range hashes still complete before publication. */
export class ObjectStreamVerifier {
  private readonly whole = createHash("sha256");
  private readonly ranges: ObjectRange[];
  private readonly active = new Map<ObjectRange, Hash>();
  private readonly proofs = new Map<string, string>();
  private offset = 0;
  private next = 0;
  private finished = false;
  private readonly bytes: number;
  private readonly sha256: string;

  constructor(
    expected: { bytes: number; sha256: string },
    ranges?: readonly ObjectRange[],
  ) {
    if (
      !Number.isSafeInteger(expected.bytes) ||
      expected.bytes < 0 ||
      expected.bytes > DEFAULTS.maxObjectBytes ||
      !/^[a-f0-9]{64}$/.test(expected.sha256)
    )
      throw Error("Invalid object stream metadata");
    this.bytes = expected.bytes;
    this.sha256 = expected.sha256;
    this.ranges = ranges
      ? objectRanges(ranges, expected.bytes).sort((a, b) => a.start - b.start)
      : [];
  }

  update(part: Uint8Array): void {
    if (this.finished) throw Error("Object stream already finished");
    // A rejected chunk permanently closes the verifier; callers cannot ignore
    // an overflow or bad slice and later obtain a successful proof.
    this.finished = true;
    if (!(part instanceof Uint8Array) || this.offset + part.length > this.bytes)
      throw Error("Object stream exceeds declared length");
    const end = this.offset + part.length;
    this.whole.update(part);
    while (
      this.next < this.ranges.length &&
      this.ranges[this.next]!.start < end
    ) {
      const range = this.ranges[this.next++]!;
      this.active.set(range, createHash("sha256"));
    }
    for (const [range, hash] of this.active) {
      hash.update(
        part.subarray(
          Math.max(range.start, this.offset) - this.offset,
          Math.min(range.endExclusive, end) - this.offset,
        ),
      );
      if (range.endExclusive <= end) {
        const digest = hash.digest("hex");
        if (digest !== range.sha256)
          throw Error("Object slice integrity failure");
        this.proofs.set(`${range.start}/${range.endExclusive}`, digest);
        this.active.delete(range);
      }
    }
    this.offset = end;
    this.finished = false;
  }

  finish(): ReadonlyMap<string, string> {
    if (this.finished) throw Error("Object stream already finished");
    this.finished = true;
    if (
      this.offset !== this.bytes ||
      this.whole.digest("hex") !== this.sha256 ||
      this.next !== this.ranges.length ||
      this.active.size
    )
      throw Error("Stored object integrity mismatch");
    return new Map(this.proofs);
  }
}
