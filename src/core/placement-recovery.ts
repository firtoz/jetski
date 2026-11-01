import type { CheckpointRegistry } from "./checkpoints.js";
import {
  type CheckpointStore,
  canonical,
  type HostProvider,
  identifier,
  type Scope,
  type StateStore,
  scopeKey,
  type Transaction,
} from "./contracts.js";
import type { Sandbox } from "./manager.js";
import type { OperationJournal } from "./operations.js";
import type { PoolJournal } from "./pool.js";
import {
  type MissingSourceRecovery,
  missingSourceRecovery,
} from "./shutdown.js";
import { parseArchive } from "./transfer.js";

export type MissingPlacementRecovery = Omit<
  MissingSourceRecovery,
  "shutdownId"
> & {
  placementId: string;
};
export function missingPlacementRecovery(
  value: unknown,
): MissingPlacementRecovery {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid placement recovery request");
  const input = value as Record<string, unknown>;
  if ("shutdownId" in input || typeof input.placementId !== "string")
    throw Error("Invalid placement recovery request");
  const { placementId, ...rest } = input;
  const { shutdownId, ...validated } = missingSourceRecovery({
    ...rest,
    shutdownId: placementId,
  });
  return { ...validated, placementId: shutdownId };
}

/** An interrupted restore has no shutdown journal. Recover only its already
 * selected durable root, after positive host absence; never retry creation. */
export async function recoverMissingPlacement(
  deps: {
    state: StateStore;
    provider: HostProvider;
    objects: CheckpointStore;
    registry: CheckpointRegistry;
    operations: OperationJournal;
    pool: PoolJournal;
  },
  scope: Scope,
  id: string,
  raw: MissingPlacementRecovery,
) {
  const input = missingPlacementRecovery(raw);
  identifier(id);
  const { state, provider, objects, registry, operations, pool } = deps;
  const replay = (tx: Transaction) => {
    const prior = operations.getIn(tx, scope, id);
    if (
      prior &&
      (prior.kind !== "recover-missing-placement" ||
        canonical(prior.input) !== canonical(input))
    )
      throw Error("Placement recovery identity conflict");
    return prior;
  };
  const previous = await state.transaction(replay);
  if (previous) return previous;
  const key = `sandbox/${scopeKey(scope)}`;
  const sourceIn = (tx: Transaction) => {
    const sandbox = tx.get<Sandbox>(key);
    const placement = operations.getIn(tx, scope, input.placementId);
    if (
      !sandbox ||
      sandbox.phase !== "quarantined" ||
      sandbox.pendingResume ||
      sandbox.generation !== input.generation ||
      canonical(sandbox.lease) !== canonical(input.lease) ||
      sandbox.placementOperation !== input.placementId ||
      sandbox.restoreCheckpoint !== input.checkpointId ||
      !placement ||
      placement.generation !== input.generation ||
      placement.kind !== "resume" ||
      placement.phase !== "uncertain" ||
      canonical(placement.input) !==
        canonical({ checkpointId: input.checkpointId })
    )
      throw Error("Placement recovery authority changed");
    return sandbox;
  };
  await state.transaction(sourceIn);
  const fence = { ...scope, generation: input.generation };
  const root = await state.transaction((tx) =>
    registry.validatedRootIn(tx, fence, input.checkpointId),
  );
  if (!root) throw Error("Recovery checkpoint unavailable");
  parseArchive(root.metadata);
  for (const frame of root.frames) {
    const head = await objects.head(frame);
    if (!head || head.bytes !== frame.bytes || head.sha256 !== frame.sha256)
      throw Error("Recovery checkpoint integrity failure");
  }
  if ((await provider.inspect(input.lease.machineId)).state !== "absent")
    throw Error("Placement host absence not established");
  return state.transaction((tx) => {
    const prior = replay(tx);
    if (prior) return prior;
    const sandbox = sourceIn(tx);
    const retained = registry
      .rootsIn(tx, fence)
      .find((entry) => entry.id === input.checkpointId);
    if (
      !retained ||
      retained.retiredAt !== null ||
      canonical(retained) !== canonical(root)
    )
      throw Error("Recovery checkpoint changed");
    operations.admitIn(tx, fence, id, "recover-missing-placement", input);
    operations.claimIn(tx, fence, id);
    const result = operations.finishIn(tx, fence, id, {
      phase: "succeeded",
      result: {
        checkpointId: input.checkpointId,
        abandonedPlacementId: input.placementId,
        unpublishedChangesUnavailable: true,
      },
      error: null,
    });
    const next = registry.recoverMissingPlacementIn(
      tx,
      fence,
      input.placementId,
      input.checkpointId,
    );
    operations.advanceIn(tx, fence);
    pool.retireMissingAssignmentIn(tx, input.lease, input.placementId);
    tx.put(`placement-recovery/${scopeKey(scope)}/${input.placementId}`, {
      operationId: id,
      fromGeneration: input.generation,
    });
    tx.put(key, {
      ...sandbox,
      generation: next.generation,
      phase: "stopped",
      lease: null,
      checkpoint: input.checkpointId,
      sourceRecovery: { operationId: id, fromGeneration: input.generation },
    });
    return result;
  });
}
