import { type CapturedArchive, parseArchive } from "./archive-format.js";
import type { CheckpointRoot } from "./checkpoints.js";
import { CHECKPOINT_FORMAT, DEFAULTS, type ObjectRange } from "./contracts.js";

export type ArchiveSegment = { object: number; offset: number };
export type PackedArchive = {
  kind: "filesystem-packs";
  version: 1;
  archive: CapturedArchive;
  segments: ArchiveSegment[];
};
export type CheckpointLayout = {
  archive: CapturedArchive;
  segments: ArchiveSegment[];
  packed: boolean;
};

/** Logical archive members and physical objects have separate identities. A root
 * retains entire physical objects even when only some of their ranges are used. */
export function checkpointLayout(root: CheckpointRoot): CheckpointLayout {
  const metadata = root.metadata;
  if (
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    metadata.kind === "filesystem-packs"
  ) {
    if (
      Object.keys(metadata).sort().join(",") !==
        "archive,kind,segments,version" ||
      metadata.version !== 1
    )
      throw Error("Invalid packed checkpoint metadata");
    const archive = parseArchive(metadata.archive),
      raw = metadata.segments;
    if (
      !Array.isArray(raw) ||
      raw.length !== archive.frames.length ||
      !Array.isArray(root.frames) ||
      root.frames.length < 1 ||
      root.frames.length > CHECKPOINT_FORMAT.maxFrames
    )
      throw Error("Packed checkpoint extent count mismatch");
    const identities = new Set<string>();
    for (const object of root.frames) {
      if (
        !object ||
        typeof object.id !== "string" ||
        identities.has(object.id) ||
        !Number.isSafeInteger(object.bytes) ||
        object.bytes < 1 ||
        object.bytes > DEFAULTS.maxObjectBytes ||
        typeof object.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(object.sha256)
      )
        throw Error("Invalid packed checkpoint object");
      identities.add(object.id);
    }
    const segments: ArchiveSegment[] = [],
      used = new Set<number>();
    const extents = new Map<
      number,
      {
        start: number;
        end: number;
        sha256: string;
        expandedSha256: string;
        expandedBytes: number;
      }[]
    >();
    for (const [index, value] of raw.entries()) {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "object,offset" ||
        typeof value.object !== "number" ||
        !Number.isSafeInteger(value.object) ||
        value.object < 0 ||
        value.object >= root.frames.length ||
        typeof value.offset !== "number" ||
        !Number.isSafeInteger(value.offset) ||
        value.offset < 0
      )
        throw Error("Invalid packed checkpoint segment");
      const frame = archive.frames[index]!,
        object = root.frames[value.object]!;
      if (value.offset + frame.bytes > object.bytes)
        throw Error("Packed checkpoint segment exceeds object");
      segments.push({ object: value.object, offset: value.offset });
      used.add(value.object);
      const prior = extents.get(value.object) ?? [];
      prior.push({
        start: value.offset,
        end: value.offset + frame.bytes,
        sha256: frame.sha256,
        expandedSha256: frame.expandedSha256,
        expandedBytes: frame.expandedBytes,
      });
      extents.set(value.object, prior);
    }
    if (used.size !== root.frames.length)
      throw Error("Unreferenced packed checkpoint object");
    for (const ranges of extents.values()) {
      ranges.sort((a, b) => a.start - b.start || a.end - b.end);
      for (let index = 1; index < ranges.length; index++) {
        const previous = ranges[index - 1]!,
          current = ranges[index]!;
        if (
          previous.end > current.start &&
          (previous.start !== current.start ||
            previous.end !== current.end ||
            previous.sha256 !== current.sha256 ||
            previous.expandedSha256 !== current.expandedSha256 ||
            previous.expandedBytes !== current.expandedBytes)
        )
          throw Error("Conflicting packed checkpoint ranges");
      }
    }
    return { archive, segments, packed: true };
  }
  const archive = parseArchive(metadata);
  if (archive.frames.length !== root.frames.length)
    throw Error("Checkpoint payload frame count mismatch");
  for (const [index, expected] of archive.frames.entries()) {
    const actual = root.frames[index];
    if (
      !actual ||
      actual.bytes !== expected.bytes ||
      actual.sha256 !== expected.sha256
    )
      throw Error("Checkpoint payload frame mismatch");
  }
  return {
    archive,
    segments: archive.frames.map((_, object) => ({ object, offset: 0 })),
    packed: false,
  };
}

export function checkpointArchive(root: CheckpointRoot): CapturedArchive {
  return checkpointLayout(root).archive;
}

/** Slice expectations are derived from every retained logical member, never
 * hidden in a storage adapter's private reachability graph. */
export function checkpointObjectRanges(
  roots: readonly CheckpointRoot[],
): Map<string, ObjectRange[]> {
  const unique = new Map<string, Map<string, ObjectRange>>();
  for (const root of roots) {
    if (
      root.metadata === null ||
      (typeof root.metadata === "object" &&
        !Array.isArray(root.metadata) &&
        root.metadata.kind === "command-output")
    )
      continue;
    const layout = checkpointLayout(root);
    if (!layout.packed) continue;
    for (const [index, segment] of layout.segments.entries()) {
      const object = root.frames[segment.object]!,
        frame = layout.archive.frames[index]!;
      const ranges = unique.get(object.id) ?? new Map<string, ObjectRange>();
      const key = `${segment.offset}/${segment.offset + frame.bytes}`;
      const previous = ranges.get(key);
      if (previous && previous.sha256 !== frame.sha256)
        throw Error("Conflicting retained slice proofs");
      ranges.set(key, {
        start: segment.offset,
        endExclusive: segment.offset + frame.bytes,
        sha256: frame.sha256,
      });
      unique.set(object.id, ranges);
    }
  }
  return new Map([...unique].map(([id, ranges]) => [id, [...ranges.values()]]));
}
