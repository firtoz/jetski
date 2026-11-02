import type { CapturedArchive } from "./archive-format.js";
import {
  type ArchiveSource,
  archiveChunks,
  archiveReadConcurrency,
} from "./archive-source.js";
import {
  checkpointArchive,
  checkpointLayout,
  type PackedArchive,
} from "./checkpoint-layout.js";
import type { CheckpointRegistry, CheckpointRoot } from "./checkpoints.js";
import {
  type CheckpointStore,
  canonical,
  DEFAULTS,
  type Fence,
  type Json,
  type ObjectInfo,
} from "./contracts.js";
import { sameObject } from "./inventory.js";
import { observeCheckpointObjects } from "./object-verification.js";
import { type PackPlan, packedPlan } from "./packed-save-journal.js";
import { validateRootPayload } from "./root-payload.js";

type Member = { object: ObjectInfo; offset: number };
const frameKey = (frame: { sha256: string; bytes: number }) =>
  `${frame.sha256}/${frame.bytes}`;
async function sha(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Physical packing changes neither host archives nor the durable source-release
 * boundary. Every logical member and whole pack is verified before publication. */
export class PackedCheckpointTransfer {
  constructor(
    private objects: CheckpointStore,
    private registry: CheckpointRegistry,
    private newId: () => string = () => crypto.randomUUID(),
  ) {}
  async save(
    fence: Fence,
    id: string,
    archive: CapturedArchive,
    source: ArchiveSource,
    previousRoot: string | undefined,
    targetBytes: number,
  ): Promise<{
    root: CheckpointRoot;
    uploadedBytes: number;
    reusedBytes: number;
  }> {
    const readLimit = archiveReadConcurrency(source),
      writeLimit = this.objects.transferConcurrency ?? 1;
    if (
      !Number.isSafeInteger(writeLimit) ||
      writeLimit < 1 ||
      writeLimit > DEFAULTS.transferConcurrency
    )
      throw Error("Invalid checkpoint transfer concurrency");
    if (
      !Number.isSafeInteger(targetBytes) ||
      targetBytes < 1 ||
      targetBytes > DEFAULTS.maxObjectBytes
    )
      throw Error("Invalid checkpoint pack target");
    const existing = await this.registry.root(fence, id);
    if (existing) {
      if (
        canonical(checkpointArchive(existing) as unknown as Json) !==
        canonical(archive as unknown as Json)
      )
        throw Error("Checkpoint operation identity conflict");
      return { root: existing, uploadedBytes: 0, reusedBytes: archive.bytes };
    }
    let record = await this.registry.packedSaves.begin(fence, id, archive);
    const known = new Map<string, ObjectInfo>();
    if (!record.plan) {
      const previous = previousRoot
        ? await this.registry.root(fence, previousRoot)
        : undefined;
      const members = new Map<string, Member>();
      if (previous) {
        validateRootPayload(previous);
        const metadata = previous.metadata;
        if (
          metadata === null ||
          (typeof metadata === "object" &&
            !Array.isArray(metadata) &&
            metadata.kind === "command-output")
        ) {
          for (const object of previous.frames)
            members.set(frameKey(object), { object, offset: 0 });
        } else {
          const layout = checkpointLayout(previous);
          for (const [index, segment] of layout.segments.entries())
            members.set(frameKey(layout.archive.frames[index]!), {
              object: previous.frames[segment.object]!,
              offset: segment.offset,
            });
        }
      }
      const wanted = archive.frames.map((frame) =>
        members.get(frameKey(frame)),
      );
      const observations = await observeCheckpointObjects(
        this.objects,
        fence,
        wanted.flatMap((member) => (member ? [member.object] : [])),
        true,
        "Reuse integrity failure",
      );
      for (const member of wanted)
        if (member && observations.get(member.object.id))
          known.set(member.object.id, member.object);
      const plan: PackPlan[] = [],
        reuse = new Map<string, number>(),
        changed: number[] = [];
      for (const [index, member] of wanted.entries()) {
        if (!member || !known.has(member.object.id)) {
          changed.push(index);
          continue;
        }
        let slot = reuse.get(member.object.id);
        if (slot === undefined) {
          slot = plan.length;
          reuse.set(member.object.id, slot);
          plan.push({ kind: "reuse", object: member.object, frames: [] });
        }
        const pack = plan[slot]!;
        if (pack.kind !== "reuse") throw Error("Packed layout conflict");
        pack.frames.push({ index, offset: member.offset });
      }
      let frames: number[] = [],
        bytes = 0;
      for (const index of changed) {
        const frame = archive.frames[index]!;
        if (frames.length && bytes + frame.bytes > targetBytes) {
          plan.push({ kind: "upload", frames });
          frames = [];
          bytes = 0;
        }
        frames.push(index);
        bytes += frame.bytes;
      }
      if (frames.length) plan.push({ kind: "upload", frames });
      record = await this.registry.packedSaves.plan(fence, id, plan);
    }
    const plan = record.plan;
    if (!plan) throw Error("Packed layout missing");
    const layout = packedPlan(fence, archive, plan);
    const expected = plan.flatMap((pack, index) => {
      const object =
        pack.kind === "reuse" ? pack.object : record.objects[String(index)];
      return object ? [object] : [];
    });
    const inspect = expected.filter((object) => {
      const previous = known.get(object.id);
      return !previous || !sameObject(previous, object);
    });
    const observed = await observeCheckpointObjects(
      this.objects,
      fence,
      inspect,
      true,
      "Packed recovery integrity failure",
    );
    for (const object of expected)
      if (observed.get(object.id)) known.set(object.id, object);
    const physical: (ObjectInfo | undefined)[] = Array.from({
      length: plan.length,
    });
    const pending: number[] = [];
    let reusedBytes = 0,
      uploadedBytes = 0;
    for (const [index, pack] of plan.entries()) {
      const object =
        pack.kind === "reuse" ? pack.object : record.objects[String(index)];
      if (pack.kind === "reuse") {
        if (!object || !known.has(object.id))
          throw Error("Reusable checkpoint pack unavailable");
        physical[index] = object;
        reusedBytes += pack.frames.reduce(
          (sum, frame) => sum + archive.frames[frame.index]!.bytes,
          0,
        );
      } else if (object && known.has(object.id)) {
        physical[index] = object;
        reusedBytes += layout.bytes[index]!;
      } else pending.push(index);
    }
    // Source preparation has its own budget. Ordered streams can fill the next
    // pack while a prior verified pack uploads; the store still bounds retained
    // buffers and every started sibling settles before publication or failure.
    const concurrency = writeLimit;
    const preparing = Array.from({ length: readLimit }, () =>
      Promise.resolve(),
    );
    // A rolling window keeps free slots useful while a slower sibling uploads.
    // Preparation lanes still serialize ordered streams. No new work is admitted
    // after an observed failure, and every admitted sibling drains before return.
    let cursor = 0,
      failed = false;
    const ranges = Math.floor(
      readLimit / Math.min(readLimit, concurrency, pending.length || 1),
    );
    const upload = async (index: number, ordinal: number) => {
      const group = plan[index]!;
      if (group.kind !== "upload") throw Error("Packed upload not planned");
      const prepare = async () => {
        const buffer = new Uint8Array(layout.bytes[index]!);
        const runs: Array<{ offset: number; bytes: number }> = [];
        for (const frameIndex of group.frames) {
          const frame = archive.frames[frameIndex]!,
            last = runs.at(-1);
          if (last && last.offset + last.bytes === frame.offset)
            last.bytes += frame.bytes;
          else runs.push({ offset: frame.offset, bytes: frame.bytes });
        }
        let cursor = 0;
        for (const run of runs) {
          for await (const part of archiveChunks(
            source,
            run.offset,
            run.bytes,
            ranges,
          )) {
            buffer.set(part, cursor);
            cursor += part.length;
          }
        }
        if (cursor !== buffer.length)
          throw Error("Packed source extent mismatch");
        let verified = 0;
        for (const frameIndex of group.frames) {
          const frame = archive.frames[frameIndex]!,
            end = verified + frame.bytes;
          if ((await sha(buffer.subarray(verified, end))) !== frame.sha256)
            throw Error("Packed source frame integrity failure");
          verified = end;
        }
        return buffer;
      };
      let buffer: Awaited<ReturnType<typeof prepare>>;
      if (concurrency <= readLimit) buffer = await prepare();
      else {
        const lane = ordinal % readLimit;
        const prepared = preparing[lane]!.then(prepare);
        preparing[lane] = prepared.then(() => undefined);
        // Preserve a rejected lane for queued siblings, while observing the
        // tail even when no later task occupies this lane.
        void preparing[lane]!.catch(() => undefined);
        buffer = await prepared;
      }
      const object = {
        owner: fence.owner,
        sandbox: fence.sandbox,
        id: this.newId(),
        bytes: buffer.length,
        sha256: await sha(buffer),
      };
      await this.registry.packedSaves.object(fence, id, index, object);
      let position = 0;
      const proofs = group.frames.map((frameIndex) => {
        const frame = archive.frames[frameIndex]!,
          start = position;
        position += frame.bytes;
        return { start, endExclusive: position, sha256: frame.sha256 };
      });
      const stored = await this.objects.put(
        { owner: object.owner, sandbox: object.sandbox, id: object.id },
        (async function* () {
          yield buffer;
        })(),
        { bytes: object.bytes, sha256: object.sha256, ranges: proofs },
      );
      if (!sameObject(stored, object))
        throw Error("Packed upload receipt mismatch");
      physical[index] = object;
      uploadedBytes += object.bytes;
    };
    const settled = await Promise.allSettled(
      Array.from(
        { length: Math.min(concurrency, pending.length) },
        async () => {
          while (!failed && cursor < pending.length) {
            const ordinal = cursor++,
              index = pending[ordinal]!;
            try {
              await upload(index, ordinal);
            } catch (error) {
              failed = true;
              throw error;
            }
          }
        },
      ),
    );
    for (const result of settled)
      if (result.status === "rejected") throw result.reason;
    if (physical.some((object) => object === undefined))
      throw Error("Packed save incomplete");
    const metadata: PackedArchive = {
      kind: "filesystem-packs",
      version: 1,
      archive,
      segments: layout.segments,
    };
    await this.registry.publish(
      fence,
      id,
      id,
      physical as ObjectInfo[],
      metadata as unknown as Json,
    );
    const root = await this.registry.root(fence, id);
    if (!root) throw Error("Checkpoint publication missing");
    return { root, uploadedBytes, reusedBytes };
  }
}
