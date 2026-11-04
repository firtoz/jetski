import type { CheckpointRoot } from "./checkpoints.js";
import { canonical, type Json, type ObjectInfo } from "./contracts.js";
import {
  type PortableMemoryManifest,
  parsePortableMemory,
  portableMemoryObjects,
} from "./portable-memory-format.js";

export type FilesystemMemoryMetadata = {
  kind: "filesystem-memory";
  version: 1;
  filesystem: Json;
  filesystemObjects: number;
  memory: PortableMemoryManifest;
};

/** Structural projection only. checkpointLayout additionally proves the FS hash
 * and both the publication and restore paths independently verify actual bytes. */
export function portableMemoryRoot(root: CheckpointRoot):
  | {
      filesystem: CheckpointRoot;
      memory: PortableMemoryManifest;
    }
  | undefined {
  const metadata = root.metadata;
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    metadata.kind !== "filesystem-memory"
  )
    return;
  if (
    Object.keys(metadata).sort().join(",") !==
      "filesystem,filesystemObjects,kind,memory,version" ||
    metadata.version !== 1 ||
    typeof metadata.filesystemObjects !== "number" ||
    !Number.isSafeInteger(metadata.filesystemObjects) ||
    metadata.filesystemObjects < 1 ||
    metadata.filesystemObjects > root.frames.length ||
    !metadata.filesystem ||
    typeof metadata.filesystem !== "object" ||
    Array.isArray(metadata.filesystem) ||
    metadata.filesystem.kind === "filesystem-memory"
  )
    throw Error("Invalid filesystem-memory root");
  const raw = metadata.memory;
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    typeof raw.owner !== "string" ||
    typeof raw.sandbox !== "string"
  )
    throw Error("Invalid portable memory scope");
  const memory = parsePortableMemory(raw, {
    owner: raw.owner,
    sandbox: raw.sandbox,
  });
  if (memory.checkpointId !== root.id)
    throw Error("Portable memory checkpoint identity mismatch");
  const frames = root.frames.slice(0, metadata.filesystemObjects);
  const expected = new Map<string, ObjectInfo>();
  const add = (object: ObjectInfo) => {
    if (object.owner !== memory.owner || object.sandbox !== memory.sandbox)
      throw Error("Portable memory root scope mismatch");
    const prior = expected.get(object.id);
    if (prior && canonical(prior) !== canonical(object))
      throw Error("Conflicting filesystem-memory object");
    expected.set(object.id, object);
  };
  for (const object of frames) add(object);
  for (const object of portableMemoryObjects(memory)) add(object);
  const observed = new Set<string>();
  for (const object of root.frames) {
    if (
      !expected.has(object.id) ||
      canonical(expected.get(object.id)!) !== canonical(object)
    )
      throw Error("Unexpected filesystem-memory object");
    observed.add(object.id);
  }
  if (observed.size !== expected.size)
    throw Error("Missing portable memory object");
  return {
    filesystem: { ...root, frames, metadata: metadata.filesystem },
    memory,
  };
}

/** Build a single retained graph. Publication is the registry's fenced verified
 * transaction; constructing this value cannot upgrade an already published root. */
export function composePortableMemoryRoot(
  filesystem: CheckpointRoot,
  manifest: PortableMemoryManifest,
): CheckpointRoot {
  const memory = parsePortableMemory(manifest, manifest);
  const frames = [...filesystem.frames],
    ids = new Map(frames.map((object) => [object.id, object]));
  for (const object of portableMemoryObjects(memory)) {
    const prior = ids.get(object.id);
    if (prior) {
      if (canonical(prior) !== canonical(object))
        throw Error("Conflicting filesystem-memory object");
    } else {
      ids.set(object.id, object);
      frames.push(object);
    }
  }
  const metadata: FilesystemMemoryMetadata = {
    kind: "filesystem-memory",
    version: 1,
    filesystem: filesystem.metadata,
    filesystemObjects: filesystem.frames.length,
    memory,
  };
  const root = { ...filesystem, id: memory.checkpointId, frames, metadata };
  portableMemoryRoot(root);
  return root;
}
