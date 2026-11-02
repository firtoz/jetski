import {
  type ArchiveSource,
  archiveChunks,
  archiveReadConcurrency,
} from "./archive-source.js";
import { PackedCheckpointTransfer } from "./packed-transfer.js";

export type { ArchiveSource } from "./archive-source.js";

import { type ArchiveFrame, parseArchive } from "./archive-format.js";
import { checkpointArchive } from "./checkpoint-layout.js";

export {
  type ArchiveFrame,
  type CapturedArchive,
  parseArchive,
} from "./archive-format.js";

import { type CheckpointRegistry, type CheckpointRoot } from "./checkpoints.js";
import {
  type CheckpointStore,
  canonical,
  DEFAULTS,
  type Fence,
  type Json,
  type ObjectInfo,
} from "./contracts.js";
import { observeCheckpointObjects } from "./object-verification.js";

/** Core publication path. A failed transfer leaves its durable writer admission
 * intact: lifecycle recovery must quarantine the source, not release it. */
export class CheckpointTransfer {
  constructor(
    private readonly objects: CheckpointStore,
    private readonly registry: CheckpointRegistry,
    private readonly newId: () => string = () => crypto.randomUUID(),
    private readonly options: { packBytes?: number } = {},
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
    const kind = await this.registry.filesystemSaveKind(fence, id);
    const target = this.options.packBytes ?? 0;
    if (
      !Number.isSafeInteger(target) ||
      target < 0 ||
      target > DEFAULTS.maxObjectBytes
    )
      throw Error("Invalid checkpoint pack target");
    if (kind === "packs" || (kind !== "frames" && target > 0))
      return new PackedCheckpointTransfer(
        this.objects,
        this.registry,
        this.newId,
      ).save(
        fence,
        id,
        archive,
        source,
        previousRoot,
        target || DEFAULTS.maxObjectBytes,
      );
    const readConcurrency = archiveReadConcurrency(source);
    const storeConcurrency = this.objects.transferConcurrency ?? 1;
    if (
      !Number.isSafeInteger(storeConcurrency) ||
      storeConcurrency < 1 ||
      storeConcurrency > DEFAULTS.maxTransferConcurrency
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
      if (canonical(checkpointArchive(existing)) !== canonical(archive))
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
    const candidates = archive.frames.map(
      (frame, index) =>
        pending[String(index)] ??
        reusable.get(`${frame.sha256}/${frame.bytes}`),
    );
    // Finish independent observations before starting uploads, so verification
    // shares neither connections nor memory with active source range batches.
    const reuseChecks = await observeCheckpointObjects(
      this.objects,
      fence,
      candidates.filter((object): object is ObjectInfo => object !== undefined),
      true,
      "Reuse integrity failure",
    );
    const frames: ObjectInfo[] = [];
    let uploadedBytes = 0,
      reusedBytes = 0;
    const transferFrame = async (index: number, frame: ArchiveFrame) => {
      const candidate = candidates[index];
      const verified = candidate ? reuseChecks.get(candidate.id) : undefined;
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
      const stored = await this.objects.put(
        address,
        archiveChunks(source, frame.offset, frame.bytes, rangesPerFrame),
        {
          bytes: frame.bytes,
          sha256: frame.sha256,
        },
      );
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
