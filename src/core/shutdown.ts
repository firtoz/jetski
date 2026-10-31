import type { CheckpointRegistry } from "./checkpoints.js";
import { decodeBase64 } from "./command-output.js";
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
};
type Dependencies = {
  state: StateStore;
  operations: OperationJournal;
  pool: PoolJournal;
  registry: CheckpointRegistry;
  objects: CheckpointStore;
  transfer: CheckpointTransfer;
  request: (lease: HostLease, action: string, payload: Json) => Promise<Json>;
  retainCommands: (scope: Scope) => Promise<boolean>;
};
const sandboxKey = (scope: Scope) => `sandbox/${scopeKey(scope)}`;
/** Persisted stop sequence. Only verified publication permits destructive cleanup.
 * Transfer failures remain fenced for explicit recovery instead of blind replay. */
export class ShutdownCoordinator {
  constructor(private readonly deps: Dependencies) {}
  private key(scope: Scope, id: string) {
    return `shutdown/${scopeKey(scope)}/${id}`;
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
  ) {
    await this.deps.state.transaction((tx) => {
      const key = this.key(record, record.id),
        current = tx.get<Shutdown>(key);
      if (!current || canonical(current) !== canonical(record))
        throw Error("Shutdown stage changed");
      tx.put(key, { ...record, stage, archive });
    });
    return { ...record, stage, archive };
  }
  async reconcile(owner: string) {
    const records = await this.deps.state.transaction((tx) =>
      tx.scan<Shutdown>(`shutdown/${owner}/`).map((row) => row.value),
    );
    for (const record of records)
      if (record.stage !== "done" && !record.blocked) await this.run(record);
  }
  private async run(initial: Shutdown) {
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
        await pool.transition(record.lease, "quiescing");
        await request(record.lease, "quiesce", payload);
        record = await this.advance(record, "outputs");
      }
      if (record.stage === "outputs") {
        if (!(await retainCommands(scope))) return;
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
              return decodeBase64(value.base64);
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
        if (!root || canonical(root.metadata) !== canonical(record.archive))
          throw Error("Durable publication unavailable");
        for (const frame of root.frames) {
          const observed = await this.deps.objects.head(frame);
          if (
            !observed ||
            observed.sha256 !== frame.sha256 ||
            observed.bytes !== frame.bytes
          )
            throw Error("Published checkpoint integrity failure");
        }
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
