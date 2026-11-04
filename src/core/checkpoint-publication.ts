import { checkpointLayout } from "./checkpoint-layout.js";
import type { CheckpointRegistry, CheckpointRoot } from "./checkpoints.js";
import { canonical, type Fence } from "./contracts.js";
import { portableMemoryRoot } from "./portable-memory-root.js";

type Payload = Pick<CheckpointRoot, "frames" | "metadata">;
/** Optional durable payload work under the existing filesystem writer. prepare
 * may upload additional immutable objects but must retain uncertain work on error.
 * validate checks the persisted caller-specific identity on initial and replayed
 * publication; it must not perform effects or accept only a matching FS digest. */
export interface CheckpointPublication {
  prepare(filesystem: CheckpointRoot): Promise<Payload>;
  validate(root: CheckpointRoot): void;
}

/** Commit one complete graph; never publish an FS-only intermediate checkpoint
 * before memory upload/verification succeeds. Extensions cannot replace the FS
 * metadata/objects or bypass the registry's ownership, integrity and writer checks. */
export async function publishCheckpoint(
  registry: CheckpointRegistry,
  fence: Fence,
  id: string,
  payload: Payload,
  publication?: CheckpointPublication,
): Promise<void> {
  if (!publication)
    return registry.publish(fence, id, id, payload.frames, payload.metadata);
  const base: CheckpointRoot = {
    id,
    ...structuredClone(payload),
    publishedAt: 0,
    retiredAt: null,
    pins: [],
  };
  const prepared = await publication.prepare(structuredClone(base));
  const complete = {
    ...base,
    frames: prepared.frames,
    metadata: prepared.metadata,
  };
  publication.validate(complete);
  checkpointLayout(complete);
  const projected = portableMemoryRoot(complete)?.filesystem ?? complete;
  if (
    canonical(projected.metadata) !== canonical(base.metadata) ||
    canonical(projected.frames) !== canonical(base.frames)
  )
    throw Error("Checkpoint extension changed filesystem payload");
  await registry.publish(fence, id, id, complete.frames, complete.metadata);
}
