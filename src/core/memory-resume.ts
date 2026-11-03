import {
  checkpointArchive,
  checkpointObjectRanges,
} from "./checkpoint-layout.js";
import type { CheckpointRegistry } from "./checkpoints.js";
import {
  type CheckpointStore,
  canonical,
  type Fence,
  type Json,
  type Scope,
  type StateStore,
  scopeKey,
  type Transaction,
} from "./contracts.js";
import type { Sandbox } from "./manager.js";
import type { MemoryCheckpointReceipt } from "./memory-contracts.js";
import { verifyCheckpointObjects } from "./object-verification.js";
import type { OperationJournal } from "./operations.js";
import type { HostLease, PoolJournal } from "./pool.js";

type Resume = Scope & {
  id: string;
  generation: number;
  image: string;
  checkpointId: string;
  filesystemSha256: string;
  memory: MemoryCheckpointReceipt | null;
  previous: HostLease | null;
  successor: HostLease | null;
  fallbackId: string;
  stage:
    | "native"
    | "discard"
    | "release"
    | "purge"
    | "cold-prepare"
    | "cold"
    | "done";
  reason: string | null;
};
type Dependencies = {
  state: StateStore;
  registry: CheckpointRegistry;
  operations: OperationJournal;
  pool: PoolJournal;
  objects: CheckpointStore;
  request: (lease: HostLease, action: string, payload: Json) => Promise<Json>;
  hostAbsent: (lease: HostLease) => Promise<boolean>;
};
const sandboxKey = (scope: Scope) => `sandbox/${scopeKey(scope)}`;
const key = (scope: Scope, id: string) =>
  `memory-resume/${scopeKey(scope)}/${id}`;

/** One persisted resume intent. Native effects are fenced on the host; a known
 * unusable image uses verified FS recovery, while uncertainty retains its source. */
export class MemoryResumeCoordinator {
  constructor(private readonly deps: Dependencies) {}
  async admit(scope: Scope, id: string) {
    const { state, operations, registry, pool } = this.deps;
    await state.transaction((tx) => {
      const prior = operations.getIn(tx, scope, id);
      if (prior) {
        if (prior.kind !== "resume-memory" || canonical(prior.input) !== "{}")
          throw Error("Operation identity conflict");
        return;
      }
      const sandbox = tx.get<Sandbox>(sandboxKey(scope));
      if (
        !sandbox ||
        sandbox.phase !== "stopped" ||
        sandbox.pendingResume ||
        !sandbox.checkpoint
      )
        throw Error("Memory resume requires a stopped checkpoint");
      if (
        sandbox.lease &&
        (!sandbox.memory || sandbox.memory.checkpointId !== sandbox.checkpoint)
      )
        throw Error(
          "Memory resume requires suspension; use filesystem resume for ordinary checkpoints",
        );
      const fence = { ...scope, generation: sandbox.generation };
      const root = registry.validatedRootIn(tx, fence, sandbox.checkpoint);
      if (!root) throw Error("Memory recovery root unavailable");
      const archive = checkpointArchive(root);
      if (
        sandbox.memory &&
        sandbox.lease &&
        sandbox.memory.filesystemSha256 !== archive.sha256
      )
        throw Error("Memory filesystem binding mismatch");
      registry.holdIn(tx, fence, id, root.id);
      operations.admitIn(tx, fence, id, "resume-memory", {});
      const successor = sandbox.lease
        ? pool.reserveMemorySuccessorIn(tx, sandbox.lease, id)
        : null;
      const record: Resume = {
        ...scope,
        id,
        generation: sandbox.generation,
        image: sandbox.image,
        checkpointId: root.id,
        filesystemSha256: archive.sha256,
        memory: sandbox.memory ?? null,
        previous: sandbox.lease,
        successor,
        fallbackId: crypto.randomUUID(),
        stage: successor ? "native" : "cold-prepare",
        reason: successor ? null : "not-retained",
      };
      tx.put(key(scope, id), record);
      tx.put(sandboxKey(scope), {
        ...sandbox,
        phase: "starting",
        pendingResume: id,
      });
    });
    return operations.get(scope, id);
  }
  private fence(record: Resume): Fence {
    return {
      owner: record.owner,
      sandbox: record.sandbox,
      generation: record.generation,
    };
  }
  private exact(tx: Transaction, record: Resume): Sandbox {
    const current = tx.get<Resume>(key(record, record.id));
    const sandbox = tx.get<Sandbox>(sandboxKey(record));
    if (
      !current ||
      canonical(current) !== canonical(record) ||
      !sandbox ||
      sandbox.generation !== record.generation ||
      sandbox.pendingResume !== record.id ||
      canonical(sandbox.lease) !== canonical(record.previous)
    )
      throw Error("Memory resume authority changed");
    return sandbox;
  }
  private async advance(
    record: Resume,
    stage: Resume["stage"],
    reason = record.reason,
  ): Promise<Resume> {
    const next = { ...record, stage, reason };
    await this.deps.state.transaction((tx) => {
      this.exact(tx, record);
      tx.put(key(record, record.id), next);
    });
    return next;
  }
  private async verify(record: Resume): Promise<void> {
    const fence = this.fence(record),
      root = await this.deps.registry.root(fence, record.checkpointId);
    if (!root || checkpointArchive(root).sha256 !== record.filesystemSha256)
      throw Error("Memory recovery publication unavailable");
    await verifyCheckpointObjects(
      this.deps.objects,
      fence,
      root.frames,
      "Memory recovery publication integrity failure",
      checkpointObjectRanges([root]),
    );
  }
  private payload(record: Resume): Json {
    return {
      lease: record.previous!,
      nextLease: record.successor!,
      image: record.image,
      checkpointId: record.checkpointId,
      memorySha256: record.memory?.sha256 ?? null,
      publication: {
        checkpointId: record.checkpointId,
        sha256: record.filesystemSha256,
      },
    };
  }
  private resumed(record: Resume, value: Json): boolean {
    return (
      !!value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.phase === "resumed" &&
      value.memoryPreserved === true &&
      value.checkpointId === record.checkpointId &&
      value.filesystemSha256 === record.filesystemSha256 &&
      value.sha256 === record.memory?.sha256 &&
      value.lease !== undefined &&
      canonical(value.lease) === canonical(record.successor)
    );
  }
  private async finishNative(record: Resume): Promise<void> {
    const { state, registry, operations, pool } = this.deps;
    await state.transaction((tx) => {
      const sandbox = this.exact(tx, record),
        old = this.fence(record);
      const next = registry.advanceIn(tx, old);
      operations.advanceIn(tx, old);
      operations.rebasePendingIn(tx, next, record.id, old.generation);
      registry.releaseIn(tx, next, record.id);
      pool.activateMemorySuccessorIn(tx, record.successor!, record.id);
      tx.put(sandboxKey(record), {
        ...sandbox,
        generation: next.generation,
        phase: "running",
        pendingResume: null,
        lease: record.successor,
        memory: null,
        restoreCheckpoint: null,
      });
      operations.finishIn(tx, next, record.id, {
        phase: "succeeded",
        error: null,
        result: {
          sandboxId: record.sandbox,
          checkpointId: record.checkpointId,
          memoryPreserved: true,
        },
      });
      tx.put(key(record, record.id), {
        ...record,
        generation: next.generation,
        stage: "done",
      });
    });
  }
  private async cold(record: Resume): Promise<void> {
    const { state, registry, operations } = this.deps;
    await state.transaction((tx) => {
      const sandbox = this.exact(tx, record),
        old = this.fence(record),
        next = registry.advanceIn(tx, old);
      operations.advanceIn(tx, old);
      operations.rebasePendingIn(tx, next, record.id, old.generation);
      registry.holdIn(tx, next, record.fallbackId, record.checkpointId);
      registry.releaseIn(tx, next, record.id);
      operations.admitIn(tx, next, record.fallbackId, "resume", {
        checkpointId: record.checkpointId,
      });
      tx.put(sandboxKey(record), {
        ...sandbox,
        generation: next.generation,
        phase: "queued",
        pendingResume: null,
        lease: null,
        memory: null,
        placementOperation: record.fallbackId,
        restoreCheckpoint: record.checkpointId,
        memoryRecovery: {
          operationId: record.id,
          memoryPreserved: false,
          reason: record.reason ?? "memory-unavailable",
        },
      });
      tx.put(key(record, record.id), {
        ...record,
        generation: next.generation,
        stage: "cold",
      });
    });
  }
  async reconcile(owner: string): Promise<void> {
    const records = await this.deps.state.transaction((tx) =>
      tx.scan<Resume>(`memory-resume/${owner}/`).map((row) => row.value),
    );
    for (const record of records)
      if (record.stage !== "done") await this.run(record);
  }
  private async run(initial: Resume): Promise<void> {
    const { state, operations, pool, request, hostAbsent } = this.deps;
    let record = initial;
    const op = await operations.get(record, record.id);
    if (op?.phase === "queued")
      await operations.claim(this.fence(record), record.id);
    if (record.stage === "cold") {
      const inner = await operations.get(record, record.fallbackId);
      if (inner?.phase !== "succeeded") return;
      await state.transaction((tx) => {
        const current = tx.get<Resume>(key(record, record.id)),
          sandbox = tx.get<Sandbox>(sandboxKey(record));
        if (
          !current ||
          canonical(current) !== canonical(record) ||
          sandbox?.phase !== "running" ||
          sandbox.placementOperation !== record.fallbackId
        )
          throw Error("Memory fallback authority changed");
        operations.finishIn(tx, this.fence(record), record.id, {
          phase: "succeeded",
          error: null,
          result: {
            sandboxId: record.sandbox,
            checkpointId: record.checkpointId,
            memoryPreserved: false,
            fallbackReason: record.reason ?? "memory-unavailable",
            resumeOperationId: record.fallbackId,
          },
        });
        tx.put(key(record, record.id), { ...record, stage: "done" });
      });
      return;
    }
    try {
      await this.verify(record);
      if (
        record.previous &&
        record.stage !== "cold-prepare" &&
        (await hostAbsent(record.previous))
      ) {
        await state.transaction((tx) => {
          this.exact(tx, record);
          pool.quiesceMemorySuccessorIn(tx, record.successor!, record.id);
          pool.retireMissingAssignmentIn(tx, record.successor!);
          tx.put(key(record, record.id), {
            ...record,
            stage: "cold-prepare",
            reason: "source-absent",
          });
        });
        record = { ...record, stage: "cold-prepare", reason: "source-absent" };
      }
      if (record.stage === "native") {
        let result: Json;
        try {
          result = await request(
            record.previous!,
            "memory-resume",
            this.payload(record),
          );
        } catch (error) {
          const status = await request(
            record.previous!,
            "memory-status",
            this.payload(record),
          );
          if (this.resumed(record, status)) result = status;
          else if (
            status &&
            typeof status === "object" &&
            !Array.isArray(status) &&
            status.canDiscard === true &&
            ["sealed", "discarding"].includes(String(status.phase))
          ) {
            record = await this.advance(
              record,
              "discard",
              "memory-unavailable",
            );
            result = null;
          } else throw error;
        }
        if (record.stage === "native") {
          if (!this.resumed(record, result))
            throw Error("Memory resume unconfirmed");
          await this.finishNative(record);
          return;
        }
      }
      if (record.stage === "discard") {
        const discarded = await request(
          record.previous!,
          "memory-discard",
          this.payload(record),
        );
        if (this.resumed(record, discarded)) {
          await this.finishNative(record);
          return;
        }
        if (
          !discarded ||
          typeof discarded !== "object" ||
          Array.isArray(discarded) ||
          discarded.phase !== "discarded" ||
          discarded.checkpointId !== record.checkpointId ||
          discarded.lease === undefined ||
          canonical(discarded.lease) !== canonical(record.successor)
        )
          throw Error("Memory discard unconfirmed");
        record = await this.advance(record, "release");
      }
      if (record.stage === "release") {
        await request(record.successor!, "release", {
          lease: record.successor!,
          image: record.image,
          publication: {
            checkpointId: record.checkpointId,
            sha256: record.filesystemSha256,
          },
        });
        record = await this.advance(record, "purge");
      }
      if (record.stage === "purge") {
        await request(record.successor!, "purge-source", {
          lease: record.successor!,
          image: record.image,
        });
        await state.transaction((tx) => {
          this.exact(tx, record);
          pool.quiesceMemorySuccessorIn(tx, record.successor!, record.id);
          pool.releaseIn(tx, record.successor!);
          tx.put(key(record, record.id), { ...record, stage: "cold-prepare" });
        });
        record = { ...record, stage: "cold-prepare" };
      }
      if (record.stage === "cold-prepare") await this.cold(record);
    } catch (error) {
      const relevant = await state.transaction((tx) => {
        const current = tx.get<Resume>(key(record, record.id)),
          sandbox = tx.get<Sandbox>(sandboxKey(record));
        if (
          !current ||
          canonical(current) !== canonical(record) ||
          !sandbox ||
          sandbox.pendingResume !== record.id
        )
          return false;
        tx.put(sandboxKey(record), { ...sandbox, phase: "quarantined" });
        operations.finishIn(tx, this.fence(record), record.id, {
          phase: "uncertain",
          result: null,
          error: "Memory resume requires reconciliation",
        });
        return true;
      });
      if (relevant && record.successor) {
        try {
          await pool.transition(record.successor, "quarantined");
        } catch {
          /* A positively retired source cannot be quarantined again. */
        }
      }
      throw error;
    }
  }
}
