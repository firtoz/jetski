import {
  type CheckpointStore,
  DEFAULTS,
  type Fence,
  identifier,
  type ObjectInfo,
} from "./contracts.js";
import { sameObject } from "./inventory.js";

/** Verify each immutable identity once; keep all work inside the writer's lifetime.
 * Adapters opt into overlap. A failed batch is fully drained before rejection. */
export async function verifyCheckpointObjects(
  store: CheckpointStore,
  fence: Fence,
  objects: ObjectInfo[],
  integrityMessage = "Publication integrity failure",
): Promise<void> {
  await observeCheckpointObjects(
    store,
    fence,
    objects,
    false,
    integrityMessage,
  );
}

/** Missing candidates may be repaired from the retained capture by the transfer
 * layer. Every present identity still requires complete verification. */
export async function observeCheckpointObjects(
  store: CheckpointStore,
  fence: Fence,
  objects: ObjectInfo[],
  allowMissing = false,
  integrityMessage = "Publication integrity failure",
): Promise<Map<string, ObjectInfo | undefined>> {
  const observations = new Map<string, ObjectInfo | undefined>();
  const concurrency = store.verificationConcurrency ?? 1;
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > DEFAULTS.verificationConcurrency
  )
    throw Error("Invalid checkpoint verification concurrency");
  const unique = new Map<string, ObjectInfo>();
  for (const object of objects) {
    if (object.owner !== fence.owner || object.sandbox !== fence.sandbox)
      throw Error("Cross-owner frame");
    identifier(object.id);
    if (
      !Number.isSafeInteger(object.bytes) ||
      object.bytes < 0 ||
      object.bytes > DEFAULTS.maxObjectBytes ||
      !/^[a-f0-9]{64}$/.test(object.sha256)
    )
      throw Error("Invalid publication object");
    const prior = unique.get(object.id);
    if (prior && !sameObject(prior, object))
      throw Error("Conflicting publication object identity");
    unique.set(object.id, object);
  }
  const values = [...unique.values()];
  for (let offset = 0; offset < values.length; offset += concurrency) {
    const settled = await Promise.allSettled(
      values.slice(offset, offset + concurrency).map(async (object) => {
        const verified = await store.head({
          owner: object.owner,
          sandbox: object.sandbox,
          id: object.id,
        });
        if (
          (!verified && !allowMissing) ||
          (verified && !sameObject(verified, object))
        )
          throw Error(integrityMessage);
        observations.set(object.id, verified);
      }),
    );
    for (const result of settled)
      if (result.status === "rejected") throw result.reason;
  }
  return observations;
}
