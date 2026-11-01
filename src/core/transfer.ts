import { type CheckpointRegistry, type CheckpointRoot } from "./checkpoints.js";
import {
  CHECKPOINT_FORMAT,
  type CheckpointStore,
  canonical,
  DEFAULTS,
  type Fence,
  type Json,
  type ObjectInfo,
} from "./contracts.js";
import { sameObject } from "./inventory.js";

export type ArchiveFrame = {
  offset: number;
  bytes: number;
  expandedBytes: number;
  sha256: string;
  expandedSha256: string;
};
export type CapturedArchive = {
  version: 1;
  sha256: string;
  bytes: number;
  expandedBytes: number;
  entries: number;
  frames: ArchiveFrame[];
};
const READ_BYTES = 256 * 1024;
const MAX_READ_CONCURRENCY = 4;

export interface ArchiveSource {
  /** Opt in only when independent immutable range reads may overlap. */
  readConcurrency?: number;
  read(offset: number, bytes: number): Promise<Uint8Array>;
}
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= min &&
  value <= max;

export function parseArchive(value: unknown): CapturedArchive {
  if (!value || typeof value !== "object") throw new Error("Invalid archive");
  const archive = value as CapturedArchive;
  if (
    Object.keys(archive).sort().join(",") !==
    "bytes,entries,expandedBytes,frames,sha256,version"
  )
    throw new Error("Unknown archive fields");
  if (
    archive.version !== 1 ||
    !digest(archive.sha256) ||
    !integer(archive.bytes, 1, 16 * 1024 ** 3) ||
    !integer(archive.expandedBytes, 0, 16 * 1024 ** 3) ||
    !integer(archive.entries, 2, 100_000) ||
    !Array.isArray(archive.frames) ||
    !integer(archive.frames.length, 1, CHECKPOINT_FORMAT.maxFrames)
  )
    throw new Error("Invalid archive manifest");
  let offset = 0,
    expanded = 0;
  for (const frame of archive.frames) {
    if (
      !frame ||
      Object.keys(frame).sort().join(",") !==
        "bytes,expandedBytes,expandedSha256,offset,sha256" ||
      frame.offset !== offset ||
      !integer(frame.bytes, 1, DEFAULTS.maxObjectBytes) ||
      !integer(
        frame.expandedBytes,
        1,
        CHECKPOINT_FORMAT.maxExpandedFrameBytes,
      ) ||
      !digest(frame.sha256) ||
      !digest(frame.expandedSha256)
    )
      throw new Error("Invalid archive frame");
    offset += frame.bytes;
    expanded += frame.expandedBytes;
  }
  if (
    offset !== archive.bytes ||
    expanded < archive.expandedBytes ||
    expanded > 18 * 1024 ** 3
  )
    throw new Error("Archive extent mismatch");
  return structuredClone(archive);
}

/** Core publication path. A failed transfer leaves its durable writer admission
 * intact: lifecycle recovery must quarantine the source, not release it. */
export class CheckpointTransfer {
  constructor(
    private readonly objects: CheckpointStore,
    private readonly registry: CheckpointRegistry,
    private readonly newId = () => crypto.randomUUID(),
  ) {}
  async save(
    fence: Fence,
    id: string,
    input: unknown,
    source: ArchiveSource,
    previousRoot?: string,
  ): Promise<{
    root: CheckpointRoot;
    uploadedBytes: number;
    reusedBytes: number;
  }> {
    const archive = parseArchive(input);
    const readConcurrency = source.readConcurrency ?? 1;
    if (
      !Number.isSafeInteger(readConcurrency) ||
      readConcurrency < 1 ||
      readConcurrency > MAX_READ_CONCURRENCY
    )
      throw Error("Invalid checkpoint read concurrency");
    const storeConcurrency = this.objects.transferConcurrency ?? 1;
    if (
      !Number.isSafeInteger(storeConcurrency) ||
      storeConcurrency < 1 ||
      storeConcurrency > DEFAULTS.transferConcurrency
    )
      throw Error("Invalid checkpoint transfer concurrency");
    // Share the source budget across frames, never multiply it by the number
    // of uploads. A source which requires serial reads also serializes frames.
    const concurrency = Math.min(
      storeConcurrency,
      readConcurrency,
      archive.frames.length,
    );
    const rangesPerFrame = Math.floor(readConcurrency / concurrency);
    const existing = await this.registry.root(fence, id);
    if (existing) {
      if (canonical(existing.metadata) !== canonical(archive))
        throw new Error("Checkpoint operation identity conflict");
      return { root: existing, uploadedBytes: 0, reusedBytes: archive.bytes };
    }
    const pending = await this.registry.beginFrameSave(
      fence,
      id,
      archive as Json,
      archive.frames.map((frame) => ({
        bytes: frame.bytes,
        sha256: frame.sha256,
      })),
    );
    const previous = previousRoot
      ? await this.registry.root(fence, previousRoot)
      : undefined;
    const reusable = new Map(
      (previous?.frames ?? []).map((frame) => [
        `${frame.sha256}/${frame.bytes}`,
        frame,
      ]),
    );
    const reuseChecks = new Map<
      string,
      { expected: ObjectInfo; check: Promise<ObjectInfo | undefined> }
    >();
    const reuse = (object: ObjectInfo) => {
      const expected = { ...object };
      if (expected.owner !== fence.owner || expected.sandbox !== fence.sandbox)
        throw Error("Cross-owner reuse object");
      const prior = reuseChecks.get(expected.id);
      if (prior) {
        if (!sameObject(prior.expected, expected))
          throw Error("Conflicting reuse object identity");
        return prior.check;
      }
      const check = this.objects
        .head({
          owner: expected.owner,
          sandbox: expected.sandbox,
          id: expected.id,
        })
        .then((verified) => {
          if (verified && !sameObject(verified, expected))
            throw Error("Reuse integrity failure");
          return verified;
        });
      reuseChecks.set(expected.id, { expected, check });
      return check;
    };
    const frames: ObjectInfo[] = [];
    let uploadedBytes = 0,
      reusedBytes = 0;
    const transferFrame = async (index: number, frame: ArchiveFrame) => {
      const candidate =
        pending[String(index)] ??
        reusable.get(`${frame.sha256}/${frame.bytes}`);
      const verified = candidate ? await reuse(candidate) : undefined;
      if (
        verified &&
        verified.owner === fence.owner &&
        verified.sandbox === fence.sandbox &&
        verified.bytes === frame.bytes &&
        verified.sha256 === frame.sha256
      ) {
        await this.registry.planFrame(fence, id, index, verified);
        return { object: verified, reused: true };
      }
      const address = {
        owner: fence.owner,
        sandbox: fence.sandbox,
        id: this.newId(),
      };
      await this.registry.planFrame(fence, id, index, {
        ...address,
        bytes: frame.bytes,
        sha256: frame.sha256,
      });
      const chunks = async function* () {
        let remaining = frame.bytes,
          offset = frame.offset;
        while (remaining) {
          const reads: Promise<Uint8Array>[] = [];
          const counts: number[] = [];
          for (let index = 0; index < rangesPerFrame && remaining; index++) {
            const count = Math.min(READ_BYTES, remaining);
            const position = offset;
            reads.push(
              Promise.resolve().then(() => source.read(position, count)),
            );
            counts.push(count);
            offset += count;
            remaining -= count;
          }
          // Drain the bounded batch even on failure. Preserve archive order and
          // never let reads outlive a failed upload or its source quarantine.
          const settled = await Promise.allSettled(reads);
          for (const [index, result] of settled.entries()) {
            if (result.status === "rejected") throw result.reason;
            if (
              !(result.value instanceof Uint8Array) ||
              result.value.length !== counts[index]
            )
              throw new Error("Short checkpoint transfer");
            yield result.value;
          }
        }
      };
      const stored = await this.objects.put(address, chunks(), {
        bytes: frame.bytes,
        sha256: frame.sha256,
      });
      if (
        stored.owner !== address.owner ||
        stored.sandbox !== address.sandbox ||
        stored.id !== address.id ||
        stored.bytes !== frame.bytes ||
        stored.sha256 !== frame.sha256
      )
        throw Error("Storage upload receipt mismatch");
      return { object: stored, reused: false };
    };
    for (
      let offset = 0;
      offset < archive.frames.length;
      offset += concurrency
    ) {
      // Keep all uploads and their range reads within the writer lifetime even
      // when one fails. Publication cannot race a surviving sibling upload.
      const settled = await Promise.allSettled(
        archive.frames
          .slice(offset, offset + concurrency)
          .map((frame, index) => transferFrame(offset + index, frame)),
      );
      for (const result of settled) {
        if (result.status === "rejected") throw result.reason;
        frames.push(result.value.object);
        if (result.value.reused) reusedBytes += result.value.object.bytes;
        else uploadedBytes += result.value.object.bytes;
      }
    }
    await this.registry.publish(fence, id, id, frames, archive as Json);
    const root = await this.registry.root(fence, id);
    if (!root) throw new Error("Checkpoint publication missing");
    return { root, uploadedBytes, reusedBytes };
  }
}
