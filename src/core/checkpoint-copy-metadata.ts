import type { CheckpointContent } from "./checkpoint-content.js";
import type { CheckpointRoot } from "./checkpoints.js";
import { canonical, type Fence, type ObjectInfo } from "./contracts.js";
import {
  composePortableMemoryRoot,
  portableMemoryRoot,
} from "./portable-memory-root.js";

/** Rebind only the publication envelope. Native checkpoint bytes remain immutable;
 * restore still proves image, resources, ABI and filesystem compatibility. */
export function copiedCheckpointMetadata(
  source: CheckpointRoot,
  target: Fence,
  id: string,
  frames: ObjectInfo[],
  content: CheckpointContent,
): CheckpointRoot["metadata"] {
  if (frames.length !== source.frames.length)
    throw Error("Copy extent mismatch");
  for (const [index, frame] of frames.entries()) {
    const original = source.frames[index]!;
    if (
      frame.owner !== target.owner ||
      frame.sandbox !== target.sandbox ||
      frame.bytes !== original.bytes ||
      frame.sha256 !== original.sha256
    )
      throw Error("Copy object binding mismatch");
  }
  if (content === "filesystem") return source.metadata;
  const portable = portableMemoryRoot(source);
  if (!portable)
    throw Error("Memory fork requires a portable memory checkpoint");
  if (
    portable.memory.owner !== target.owner ||
    portable.memory.sandbox === target.sandbox
  )
    throw Error("Memory fork requires distinct same-owner scopes");
  const objects = new Map(
    source.frames.map((frame, index) => [frame.id, frames[index]!]),
  );
  const manifest = structuredClone(portable.memory);
  manifest.owner = target.owner;
  manifest.sandbox = target.sandbox;
  manifest.generation = target.generation;
  manifest.checkpointId = id;
  for (const file of manifest.files)
    for (const chunk of file.chunks) {
      const object = objects.get(chunk.object.id);
      if (!object) throw Error("Memory fork object missing");
      chunk.object = { ...object };
    }
  const root = composePortableMemoryRoot(
    {
      ...portable.filesystem,
      id,
      frames: frames.slice(0, portable.filesystem.frames.length),
    },
    manifest,
  );
  if (canonical(root.frames) !== canonical(frames))
    throw Error("Memory fork graph mismatch");
  return root.metadata;
}
