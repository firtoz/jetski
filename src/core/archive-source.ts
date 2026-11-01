export const CHECKPOINT_READ_BYTES = 256 * 1024;
export const MAX_CHECKPOINT_READ_CONCURRENCY = 4;
export interface ArchiveSource {
  /** Independent immutable range reads may overlap only after opting in. */
  readConcurrency?: number;
  read(offset: number, bytes: number): Promise<Uint8Array>;
}
export function archiveReadConcurrency(source: ArchiveSource): number {
  const limit = source.readConcurrency ?? 1;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_CHECKPOINT_READ_CONCURRENCY
  )
    throw Error("Invalid checkpoint read concurrency");
  return limit;
}
/** Ordered bounded ranges. All started reads drain before a failed batch exits. */
export async function* archiveChunks(
  source: ArchiveSource,
  offset: number,
  remaining: number,
  concurrency: number,
): AsyncGenerator<Uint8Array> {
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > archiveReadConcurrency(source)
  )
    throw Error("Invalid checkpoint read concurrency");
  while (remaining) {
    const reads: Promise<Uint8Array>[] = [],
      counts: number[] = [];
    for (let index = 0; index < concurrency && remaining; index++) {
      const count = Math.min(CHECKPOINT_READ_BYTES, remaining),
        position = offset;
      reads.push(Promise.resolve().then(() => source.read(position, count)));
      counts.push(count);
      offset += count;
      remaining -= count;
    }
    const settled = await Promise.allSettled(reads);
    for (const [index, result] of settled.entries()) {
      if (result.status === "rejected") throw result.reason;
      if (
        !(result.value instanceof Uint8Array) ||
        result.value.length !== counts[index]
      )
        throw Error("Short checkpoint transfer");
      yield result.value;
    }
  }
}
