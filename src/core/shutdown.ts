import { MAX_CHECKPOINT_READ_BYTES } from "./archive-source.js";
import {
  checkpointArchive,
  checkpointObjectRanges,
} from "./checkpoint-layout.js";
import type { CheckpointRegistry } from "./checkpoints.js";
import { decodeBase64 } from "./command-output.js";
import {
  type CheckpointStore,
  canonical,
  type Fence,
  identifier,
  type Json,
  type Scope,
  type StateStore,
  scopeKey,
  type Transaction,
} from "./contracts.js";
import type { Sandbox } from "./manager.js";
import { verifyCheckpointObjects } from "./object-verification.js";
import type { OperationJournal } from "./operations.js";
import type { HostLease, PoolJournal } from "./pool.js";
import {
  type CapturedArchive,
  CheckpointTransfer,
  parseArchive,
} from "./transfer.js";

export const SHUTDOWN_MODES = ["checkpoint", "stop", "delete"] as const;
export type ShutdownMode = (typeof SHUTDOWN_MODES)[number];
type Stage =
  | "quiesce"
  | "outputs"
  | "capture"
  | "publish"
  | "remove"
  | "release"
  | "purge"
  | "finish"
  | "done";
type Shutdown = {
  owner: string;
  sandbox: string;
  id: string;
  mode: ShutdownMode;
  lease: HostLease;
  image: string;
  generation: number;
  previous: string | null;
  stage: Stage;
  archive: CapturedArchive | null;
  blocked: boolean;
  recoveredBy?: string;
  finalizeVersion?: 1;
  readChunkBytes?: number;
};
export type MissingSourceRecovery = {
  generation: number;
  lease: HostLease;
  shutdownId: string;
  checkpointId: string;
  acknowledgement: "unpublished-changes-unavailable";
};
export function missingSourceRecovery(value: unknown): MissingSourceRecovery {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid recovery request");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).sort().join(",") !==
      "acknowledgement,checkpointId,generation,lease,shutdownId" ||
    input.acknowledgement !== "unpublished-changes-unavailable" ||
    !Number.isSafeInteger(input.generation) ||
    Number(input.generation) < 1 ||
    typeof input.shutdownId !== "string" ||
    typeof input.checkpointId !== "string" ||
    !input.lease ||
    typeof input.lease !== "object" ||
    Array.isArray(input.lease)
  )
    throw Error("Invalid recovery request");
  identifier(input.shutdownId);
  identifier(input.checkpointId);
  const lease = input.lease as Record<string, unknown>;
  if (
    Object.keys(lease).sort().join(",") !==
      "assignmentId,generation,machineId,owner,poolId,sandboxId,slotId" ||
    !Number.isSafeInteger(lease.generation) ||
    Number(lease.generation) < 1
  )
    throw Error("Invalid recovery lease");
  for (const key of [
    "assignmentId",
    "machineId",
    "owner",
    "poolId",
    "sandboxId",
    "slotId",
  ]) {
    if (typeof lease[key] !== "string") throw Error("Invalid recovery lease");
    identifier(lease[key]);
  }
  return structuredClone(value) as MissingSourceRecovery;
}
type Dependencies = {
  state: StateStore;
  operations: OperationJournal;
  pool: PoolJournal;
  registry: CheckpointRegistry;
  objects: CheckpointStore;
  transfer: CheckpointTransfer;
  request: (lease: HostLease, action: string, payload: Json) => Promise<Json>;
  retainCommands: (scope: Scope, lease: HostLease) => Promise<boolean>;
  hostAbsent: (lease: HostLease) => Promise<boolean>;
  settleUploads: (scope: Scope) => Promise<void>;
};
const sandboxKey = (scope: Scope) => `sandbox/${scopeKey(scope)}`;
/** Persisted stop sequence. Only verified publication permits destructive cleanup.
 * Transfer failures remain fenced for explicit recovery instead of blind replay. */
export class ShutdownCoordinator {
  constructor(private readonly deps: Dependencies) {}
  private key(scope: Scope, id: string) {
    return `shutdown/${scopeKey(scope)}/${id}`;
  }
  async recoverMissingSource(
    scope: Scope,
    id: string,
    input: MissingSourceRecovery,
  ) {
    input = missingSourceRecovery(input);
    identifier(id);
    const { state, operations, registry, pool, objects } = this.deps;
    const previous = await operations.get(scope, id);
    if (previous) {
      if (
        previous.kind !== "recover-missing-source" ||
        canonical(previous.input) !== canonical(input)
      )
        throw Error("Recovery identity conflict");
      return previous;
    }
    const sourceIn = (tx: Transaction) => {
      const sandbox = tx.get<Sandbox>(sandboxKey(scope));
      const record = tx.get<Shutdown>(this.key(scope, input.shutdownId));
      if (
        !sandbox ||
        sandbox.phase !== "quarantined" ||
        sandbox.pendingResume ||
        sandbox.generation !== input.generation ||
        canonical(sandbox.lease) !== canonical(input.lease) ||
        !record ||
        record.blocked ||
        record.generation !== input.generation ||
        canonical(record.lease) !== canonical(input.lease) ||
        !["quiesce", "outputs", "capture", "publish"].includes(record.stage)
      )
        throw Error("Recovery source authority changed");
      return { sandbox, record };
    };
    await state.transaction(sourceIn);
    const fence = { ...scope, generation: input.generation };
    const root = await state.transaction((tx) =>
      registry.validatedRootIn(tx, fence, input.checkpointId),
    );
    if (!root) throw Error("Recovery checkpoint unavailable");
    checkpointArchive(root);
    await verifyCheckpointObjects(
      objects,
      fence,
      root.frames,
      "Recovery checkpoint integrity failure",
      checkpointObjectRanges([root]),
    );
    if (!(await this.deps.hostAbsent(input.lease)))
      throw Error("Source absence not established");
    return state.transaction((tx) => {
      const prior = operations.getIn(tx, scope, id);
      if (prior) {
        if (
          prior.kind !== "recover-missing-source" ||
          canonical(prior.input) !== canonical(input)
        )
          throw Error("Recovery identity conflict");
        return prior;
      }
      const { sandbox, record } = sourceIn(tx);
      const retained = registry
        .rootsIn(tx, fence)
        .find((candidate) => candidate.id === input.checkpointId);
      if (
        !retained ||
        canonical(retained) !== canonical(root) ||
        retained.retiredAt !== null
      )
        throw Error("Recovery checkpoint changed");
      operations.admitIn(tx, fence, id, "recover-missing-source", input);
      operations.claimIn(tx, fence, id);
      const result = operations.finishIn(tx, fence, id, {
        phase: "succeeded",
        result: {
          checkpointId: input.checkpointId,
          abandonedShutdownId: input.shutdownId,
          unpublishedChangesUnavailable: true,
        },
        error: null,
      });
      const next = registry.recoverMissingSourceIn(
        tx,
        fence,
        input.shutdownId,
        input.checkpointId,
      );
      operations.advanceIn(tx, fence);
      pool.retireMissingAssignmentIn(tx, input.lease);
      tx.put(this.key(scope, input.shutdownId), {
        ...record,
        blocked: true,
        recoveredBy: id,
      });
      tx.put(sandboxKey(scope), {
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
  async admit(scope: Scope, id: string, mode: ShutdownMode) {
    const { state, operations } = this.deps;
    const fence = await operations.generation(scope);

    await state.transaction((tx) => this.admitIn(tx, fence, id, mode));
    return operations.get(scope, id);
  }
  admitIn(tx: Transaction, fence: Fence, id: string, mode: ShutdownMode) {
    const scope = { owner: fence.owner, sandbox: fence.sandbox };
    const operations = this.deps.operations;
    operations.admitIn(tx, fence, id, mode, {});
    const key = this.key(scope, id),
      prior = tx.get<Shutdown>(key);
    if (prior) {
      if (prior.mode !== mode) throw Error("Shutdown identity conflict");
      return;
    }
    const sandbox = tx.get<Sandbox>(sandboxKey(scope));
    if (!sandbox?.lease || !["running", "stopped"].includes(sandbox.phase))
      throw Error("Sandbox cannot stop");
    tx.put(key, {
      ...scope,
      id,
      mode,
      lease: sandbox.lease,
      image: sandbox.image,
      generation: sandbox.generation,
      previous: sandbox.checkpoint,
      stage: "quiesce",
      archive: null,
      blocked: false,
    });
    // Shares the command-admission transaction boundary: no later command starts.
    tx.put(sandboxKey(scope), { ...sandbox, phase: "stopping" });
  }
  private async advance(
    record: Shutdown,
    stage: Stage,
    archive = record.archive,
    finalizeVersion = record.finalizeVersion,
    readChunkBytes = record.readChunkBytes,
  ) {
    await this.deps.state.transaction((tx) => {
      const key = this.key(record, record.id),
        current = tx.get<Shutdown>(key);
      if (!current || canonical(current) !== canonical(record))
        throw Error("Shutdown stage changed");
      tx.put(key, {
        ...record,
        stage,
        archive,
        ...(finalizeVersion === 1 ? { finalizeVersion } : {}),
        ...(readChunkBytes !== undefined ? { readChunkBytes } : {}),
      });
    });
    return {
      ...record,
      stage,
      archive,
      ...(finalizeVersion === 1 ? { finalizeVersion } : {}),
      ...(readChunkBytes !== undefined ? { readChunkBytes } : {}),
    };
  }
  async reconcile(owner: string) {
    const records = await this.deps.state.transaction((tx) =>
      tx.scan<Shutdown>(`shutdown/${owner}/`).map((row) => row.value),
    );
    for (const record of records)
      if (record.stage !== "done" && !record.blocked) await this.run(record);
  }
  private async run(initial: Shutdown): Promise<void> {
    const {
      state,
      operations,
      pool,
      registry,
      transfer,
      request,
      retainCommands,
    } = this.deps;
    let record = initial;
    const scope = { owner: record.owner, sandbox: record.sandbox },
      fence = { ...scope, generation: record.generation };
    const operationFence = await operations.generation(scope);
    const operation = await operations.get(scope, record.id);
    if (operation?.phase === "queued")
      await operations.claim(operationFence, record.id);
    const payload = { lease: record.lease, image: record.image };
    try {
      if (record.stage === "quiesce") {
        await this.deps.settleUploads(scope);
        await pool.transition(record.lease, "quiescing");
        const receipt = await request(record.lease, "quiesce", payload);
        const finalizeVersion =
          receipt &&
          typeof receipt === "object" &&
          !Array.isArray(receipt) &&
          receipt.finalizeVersion === 1
            ? 1
            : undefined;
        const advertised =
          receipt && typeof receipt === "object" && !Array.isArray(receipt)
            ? receipt.checkpointReadBytes
            : undefined;
        const readChunkBytes =
          typeof advertised === "number" &&
          Number.isSafeInteger(advertised) &&
          advertised >= 1 &&
          advertised <= MAX_CHECKPOINT_READ_BYTES
            ? advertised
            : undefined;
        record = await this.advance(
          record,
          "outputs",
          record.archive,
          finalizeVersion,
          readChunkBytes,
        );
      }
      if (record.stage === "outputs") {
        if (!(await retainCommands(scope, record.lease))) return;
        record = await this.advance(record, "capture");
      }
      if (record.stage === "capture") {
        const archive = parseArchive(
          await request(record.lease, "capture", payload),
        );
        record = await this.advance(record, "publish", archive);
      }
      if (record.stage === "publish") {
        if (!record.archive) throw Error("Missing archive receipt");
        await transfer.save(
          fence,
          record.id,
          record.archive,
          {
            readConcurrency: 4,
            readChunkBytes: record.readChunkBytes,
            read: async (offset, bytes) => {
              const value = await request(record.lease, "read-checkpoint", {
                ...payload,
                offset,
                bytes,
              });
              if (
                !value ||
                typeof value !== "object" ||
                Array.isArray(value) ||
                value.offset !== offset ||
                value.bytes !== bytes ||
                typeof value.base64 !== "string"
              )
                throw Error("Invalid archive segment");
              return decodeBase64(value.base64, bytes);
            },
          },
          record.previous ?? undefined,
        );
        record = await this.advance(
          record,
          record.mode === "checkpoint" ? "finish" : "remove",
        );
      }
      // Recheck retained metadata before each cleanup continuation, including restart.
      if (["remove", "release", "purge", "finish"].includes(record.stage)) {
        const root = await registry.root(fence, record.id);
        if (
          !root ||
          canonical(checkpointArchive(root)) !== canonical(record.archive)
        )
          throw Error("Durable publication unavailable");
        await verifyCheckpointObjects(
          this.deps.objects,
          fence,
          root.frames,
          "Published checkpoint integrity failure",
          checkpointObjectRanges([root]),
        );
      }
      if (record.stage === "remove" && record.finalizeVersion === 1) {
        const receipt = await request(record.lease, "finalize", {
          ...payload,
          publication: {
            checkpointId: record.id,
            sha256: record.archive!.sha256,
          },
        });
        if (
          !receipt ||
          typeof receipt !== "object" ||
          Array.isArray(receipt) ||
          receipt.finalized !== true ||
          receipt.checkpointId !== record.id
        )
          throw Error("Host finalization unconfirmed");
        record = await this.advance(record, "finish");
      }
      if (record.stage === "remove") {
        await request(record.lease, "remove", payload);
        record = await this.advance(record, "release");
      }
      if (record.stage === "release") {
        await request(record.lease, "release", {
          ...payload,
          publication: {
            checkpointId: record.id,
            sha256: record.archive!.sha256,
          },
        });
        record = await this.advance(record, "purge");
      }
      if (record.stage === "purge") {
        await request(record.lease, "purge-source", payload);
        record = await this.advance(record, "finish");
      }
      if (record.stage === "finish") {
        if (record.mode !== "checkpoint") await pool.release(record.lease);
        await state.transaction((tx) => {
          const sandbox = tx.get<Sandbox>(sandboxKey(scope));
          if (
            !sandbox?.lease ||
            canonical(sandbox.lease) !== canonical(record.lease)
          ) {
            if (
              sandbox?.phase ===
                (record.mode === "delete" ? "deleted" : "stopped") &&
              sandbox.checkpoint === record.id
            )
              return;
            throw Error("Shutdown assignment changed");
          }
          tx.put(sandboxKey(scope), {
            ...sandbox,
            phase: record.mode === "delete" ? "deleted" : "stopped",
            checkpoint: record.id,
            lease: record.mode === "checkpoint" ? record.lease : null,
          });
        });
        await operations.finish(operationFence, record.id, {
          phase: "succeeded",
          result: { checkpointId: record.id },
          error: null,
        });
        await this.advance(record, "done");
      }
    } catch (error) {
      // A verified publication survives loss of its execution host. Absence
      // proves no local workload remains, but never substitutes for publication.
      if (["remove", "release", "purge"].includes(record.stage)) {
        try {
          if (await this.deps.hostAbsent(record.lease)) {
            return await this.run(await this.advance(record, "finish"));
          }
        } catch {
          // Keep the original failure and quarantine if recovery is ambiguous.
        }
      }
      await state.transaction((tx) => {
        const key = this.key(record, record.id),
          current = tx.get<Shutdown>(key);
        if (current && canonical(current) === canonical(record))
          tx.put(key, {
            ...record,
            blocked: false,
          });
        const sandbox = tx.get<Sandbox>(sandboxKey(scope));
        if (
          sandbox?.lease &&
          canonical(sandbox.lease) === canonical(record.lease)
        )
          tx.put(sandboxKey(scope), { ...sandbox, phase: "quarantined" });
      });
      await operations.finish(operationFence, record.id, {
        phase: "uncertain",
        result: null,
        error: "Shutdown requires reconciliation",
      });
      throw error;
    }
  }
}
