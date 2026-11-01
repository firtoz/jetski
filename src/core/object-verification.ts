import {
  type CheckpointStore,
  DEFAULTS,
  type Fence,
  identifier,
  type ObjectInfo,
  type ObjectRange,
} from "./contracts.js";
import { sameObject } from "./inventory.js";
import {
  objectRanges,
  verifyObjectRanges,
  wholeObjectProof,
} from "./object-ranges.js";

/** Verify each immutable identity once; keep all work inside the writer's lifetime.
 * Adapters opt into overlap. A failed batch is fully drained before rejection. */
export async function verifyCheckpointObjects(
  store: CheckpointStore,
  fence: Fence,
  objects: ObjectInfo[],
  integrityMessage = "Publication integrity failure",
  projections?: ReadonlyMap<string, readonly ObjectRange[]>,
): Promise<void> {
  await observeCheckpointObjects(
    store,
    fence,
    objects,
    false,
    integrityMessage,
    projections,
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
  projections?: ReadonlyMap<string, readonly ObjectRange[]>,
): Promise<Map<string, ObjectInfo | undefined>> {
  const observations = new Map<string, ObjectInfo | undefined>();
  let concurrency = store.verificationConcurrency ?? 1;
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
  const ranges = new Map<string, ObjectRange[]>();
  for (const [id, input] of projections ?? []) {
    const object = unique.get(id);
    if (!object || allowMissing)
      throw Error("Unexpected object range identity");
    ranges.set(id, objectRanges(input, object.bytes));
  }
  // Fallback reads retain bounded bodies for hashing. Keep their combined
  // object buffers below16MiB; capable adapters own their advertised bound.
  if (!store.verifyRanges && ranges.size) {
    const buffered = [...ranges].filter(
      ([id, proof]) => !wholeObjectProof(unique.get(id)!, proof),
    );
    if (buffered.length) {
      const largest = Math.max(
        ...buffered.map(([id]) => unique.get(id)!.bytes),
      );
      concurrency = Math.min(
        concurrency,
        Math.max(1, Math.floor((16 * 1024 * 1024) / largest)),
      );
    }
  }
  const values = [...unique.values()];
  for (let offset = 0; offset < values.length; offset += concurrency) {
    const settled = await Promise.allSettled(
      values.slice(offset, offset + concurrency).map(async (object) => {
        const proof = ranges.get(object.id);
        if (proof) {
          await verifyObjectRanges(store, object, proof);
          observations.set(object.id, { ...object });
          return;
        }
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
