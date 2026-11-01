import { CHECKPOINT_FORMAT, DEFAULTS } from "./contracts.js";

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
