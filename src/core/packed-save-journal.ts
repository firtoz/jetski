import type { CapturedArchive } from "./archive-format.js";
import {
  type ArchiveSegment,
  checkpointLayout,
  type PackedArchive,
} from "./checkpoint-layout.js";
import {
  canonical,
  DEFAULTS,
  type Fence,
  identifier,
  type Json,
  type ObjectInfo,
  type StateStore,
  scopeKey,
  type Transaction,
} from "./contracts.js";

export type PackPlan =
  | { kind: "upload"; frames: number[] }
  | {
      kind: "reuse";
      object: ObjectInfo;
      frames: { index: number; offset: number }[];
    };
export type PackedSaveRecord = {
  version: 1;
  generation: number;
  archive: CapturedArchive;
  plan: PackPlan[] | null;
  objects: Record<string, ObjectInfo>;
};
type Access = {
  admit(tx: Transaction, fence: Fence, id: string): void;
  assert(tx: Transaction, fence: Fence, id: string): void;
};

function objectInfo(fence: Fence, object: ObjectInfo): void {
  if (
    !object ||
    typeof object.id !== "string" ||
    object.owner !== fence.owner ||
    object.sandbox !== fence.sandbox ||
    !Number.isSafeInteger(object.bytes) ||
    object.bytes < 1 ||
    object.bytes > DEFAULTS.maxObjectBytes ||
    typeof object.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(object.sha256)
  )
    throw Error("Invalid packed save object");
  identifier(object.id);
}

/** A deterministic layout is persisted independently of later physical upload
 * receipts. Physical indices survive object-ID replacement after lost PUT ACKs. */
export function packedPlan(
  fence: Fence,
  archive: CapturedArchive,
  plan: readonly PackPlan[],
): { segments: ArchiveSegment[]; bytes: number[] } {
  if (
    !Array.isArray(plan) ||
    plan.length < 1 ||
    plan.length > archive.frames.length
  )
    throw Error("Invalid packed save layout");
  const segments: (ArchiveSegment | undefined)[] = Array.from({
    length: archive.frames.length,
  });
  const physical: ObjectInfo[] = [],
    sizes: number[] = [],
    reused = new Set<string>();
  const assign = (index: number, object: number, offset: number) => {
    if (
      !Number.isSafeInteger(index) ||
      !archive.frames[index] ||
      segments[index] !== undefined
    )
      throw Error("Ambiguous packed source membership");
    segments[index] = { object, offset };
  };
  for (const [index, pack] of plan.entries()) {
    if (!pack || !Array.isArray(pack.frames) || pack.frames.length < 1)
      throw Error("Invalid packed save group");
    let bytes = 0;
    if (pack.kind === "upload") {
      if (Object.keys(pack).sort().join(",") !== "frames,kind")
        throw Error("Unknown packed save fields");
      for (const frame of pack.frames) {
        assign(frame, index, bytes);
        bytes += archive.frames[frame]!.bytes;
      }
    } else if (pack.kind === "reuse") {
      if (Object.keys(pack).sort().join(",") !== "frames,kind,object")
        throw Error("Unknown packed save fields");
      objectInfo(fence, pack.object);
      if (reused.has(pack.object.id))
        throw Error("Duplicate reused pack identity");
      reused.add(pack.object.id);
      for (const frame of pack.frames) {
        if (!frame || Object.keys(frame).sort().join(",") !== "index,offset")
          throw Error("Invalid reused pack frame");
        assign(frame.index, index, frame.offset);
      }
      bytes = pack.object.bytes;
    } else throw Error("Unknown packed save group");
    if (bytes < 1 || bytes > DEFAULTS.maxObjectBytes)
      throw Error("Packed save size bound");
    physical.push({
      owner: fence.owner,
      sandbox: fence.sandbox,
      id: `slot-${index}`,
      bytes,
      sha256: "0".repeat(64),
    });
    sizes.push(bytes);
  }
  if (segments.some((segment) => segment === undefined))
    throw Error("Incomplete packed save layout");
  const complete = segments as ArchiveSegment[];
  const metadata: PackedArchive = {
    kind: "filesystem-packs",
    version: 1,
    archive,
    segments: complete,
  };
  checkpointLayout({
    id: "layout",
    frames: physical,
    metadata: metadata as unknown as Json,
    publishedAt: 0,
    retiredAt: null,
    pins: [],
  });
  return { segments: complete, bytes: sizes };
}

export class PackedSaveJournal {
  constructor(
    private state: StateStore,
    private access: Access,
  ) {}
  private key(fence: Fence, id: string) {
    return `packed-save/${scopeKey(fence)}/${identifier(id)}`;
  }
  private load(tx: Transaction, fence: Fence, id: string): PackedSaveRecord {
    const record = tx.get(this.key(fence, id)) as PackedSaveRecord | undefined;
    if (
      !record ||
      record.version !== 1 ||
      record.generation !== fence.generation
    )
      throw Error("Packed save generation mismatch");
    this.access.assert(tx, fence, id);
    return record;
  }
  async begin(
    fence: Fence,
    id: string,
    archive: CapturedArchive,
  ): Promise<PackedSaveRecord> {
    return this.state.transaction((tx) => {
      const key = this.key(fence, id),
        previous = tx.get(key) as PackedSaveRecord | undefined;
      if (previous) {
        const record = this.load(tx, fence, id);
        if (
          canonical(record.archive as unknown as Json) !==
          canonical(archive as unknown as Json)
        )
          throw Error("Packed save operation identity conflict");
        return structuredClone(record);
      }
      this.access.admit(tx, fence, id);
      const record: PackedSaveRecord = {
        version: 1,
        generation: fence.generation,
        archive: structuredClone(archive),
        plan: null,
        objects: {},
      };
      tx.put(key, record as unknown as Json);
      return structuredClone(record);
    });
  }
  async plan(
    fence: Fence,
    id: string,
    input: readonly PackPlan[],
  ): Promise<PackedSaveRecord> {
    const proposal = structuredClone(input) as PackPlan[];
    return this.state.transaction((tx) => {
      const record = this.load(tx, fence, id);
      if (record.plan) return structuredClone(record);
      packedPlan(fence, record.archive, proposal);
      const next = { ...record, plan: proposal };
      tx.put(this.key(fence, id), next as unknown as Json);
      return structuredClone(next);
    });
  }
  async object(
    fence: Fence,
    id: string,
    index: number,
    input: ObjectInfo,
  ): Promise<void> {
    const object = {
      owner: input.owner,
      sandbox: input.sandbox,
      id: input.id,
      bytes: input.bytes,
      sha256: input.sha256,
    };
    objectInfo(fence, object);
    await this.state.transaction((tx) => {
      const record = this.load(tx, fence, id);
      if (
        !record.plan ||
        !Number.isSafeInteger(index) ||
        record.plan[index]?.kind !== "upload"
      )
        throw Error("Packed object not planned");
      const layout = packedPlan(fence, record.archive, record.plan);
      if (object.bytes !== layout.bytes[index])
        throw Error("Packed object extent mismatch");
      const previous = record.objects[String(index)];
      if (
        previous &&
        (previous.bytes !== object.bytes || previous.sha256 !== object.sha256)
      )
        throw Error("Packed source identity changed");
      if (
        Object.entries(record.objects).some(
          ([key, value]) => key !== String(index) && value.id === object.id,
        ) ||
        record.plan.some(
          (pack) => pack.kind === "reuse" && pack.object.id === object.id,
        )
      )
        throw Error("Packed physical identity conflict");
      record.objects[String(index)] = object;
      tx.put(this.key(fence, id), record as unknown as Json);
    });
  }
}
