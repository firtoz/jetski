import { CheckpointRegistry } from "./checkpoints.js";
import { CommandOutputStore, type OutputChannel } from "./command-output.js";
import {
  type CheckpointStore,
  canonical,
  DEFAULTS,
  type HostProvider,
  identifier,
  type Json,
  type Scope,
  type StateStore,
  scopeKey,
} from "./contracts.js";
import { OperationJournal } from "./operations.js";
import { type HostLease, PoolJournal } from "./pool.js";
import { restoreCheckpoint } from "./restore.js";
import { ShutdownCoordinator, type ShutdownMode } from "./shutdown.js";
import { CheckpointTransfer } from "./transfer.js";
import { HOST_PROTOCOL_VERSION, type HostTransport } from "./transport.js";

export type Sandbox = {
  id: string;
  owner: string;
  image: string;
  createOperation: string;
  placementOperation: string;
  restoreCheckpoint: string | null;
  pendingResume: string | null;
  phase:
    | "queued"
    | "starting"
    | "running"
    | "stopping"
    | "stopped"
    | "quarantined"
    | "deleted";
  lease: HostLease | null;
  checkpoint: string | null;
  generation: number;
};
type ResumeRecord = {
  generation: number;
  checkpointId: string;
  releaseId: string | null;
  placed: boolean;
};
type CommandRecord = {
  id: string;
  lease: HostLease;
  image: string;
  spec: { argv: string[]; cwd: string; timeout: number };
};

export type ManagerOptions = {
  poolId: string;
  approvedImages: string[];
  hostsPerOwner?: number;
  now?: () => number;
};

/** Portable lifecycle coordinator; all principal scope is supplied by the caller's
 * identity boundary. Private host-control methods are never public API routes. */
export class SandboxManager {
  private readonly pool: PoolJournal;
  private readonly operations: OperationJournal;
  private readonly checkpoints: CheckpointRegistry;
  private readonly outputs: CommandOutputStore;
  private readonly activeOwners = new Set<string>();
  private readonly images: Set<string>;
  private readonly shutdown: ShutdownCoordinator;
  private readonly now: () => number;
  constructor(
    private readonly state: StateStore,
    private readonly provider: HostProvider,
    private readonly transport: HostTransport,
    private readonly objects: CheckpointStore,
    options: ManagerOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.pool = new PoolJournal(
      state,
      options.poolId,
      this.now,
      () => crypto.randomUUID(),
      options.hostsPerOwner ?? 1,
    );
    this.operations = new OperationJournal(state, this.now);
    this.checkpoints = new CheckpointRegistry(state, objects, this.now);
    this.outputs = new CommandOutputStore(objects, this.checkpoints);
    this.shutdown = new ShutdownCoordinator({
      state,
      operations: this.operations,
      pool: this.pool,
      registry: this.checkpoints,
      objects,
      transfer: new CheckpointTransfer(objects, this.checkpoints),
      request: (lease, action, payload) => this.request(lease, action, payload),
      retainCommands: async (scope) => {
        const commands = await state.transaction((tx) =>
          tx
            .scan<CommandRecord>(`command/${scopeKey(scope)}/`)
            .map((row) => row.value),
        );
        for (const command of commands) {
          const status = await this.commandStatus(scope, command.id);
          if (!status || typeof status !== "object" || Array.isArray(status))
            throw Error("Invalid command receipt");
          if (["queued", "running"].includes(String(status.phase)))
            return false;
          await this.retainCommand(scope, command.id);
        }
        return true;
      },
    });
    this.images = new Set(options.approvedImages);
    for (const image of this.images)
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(image))
        throw new Error("Approved image must be digest pinned");
  }
  private key(scope: Scope) {
    return `sandbox/${scopeKey(scope)}`;
  }
  private uuid(value: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        value,
      )
    )
      throw new Error("UUID required");
    return value;
  }
  async create(
    owner: string,
    id: string,
    image: string,
    operationId: string,
  ): Promise<Sandbox> {
    identifier(owner);
    this.uuid(id);
    this.uuid(operationId);
    if (!this.images.has(image)) throw new Error("Image not approved");
    const scope = { owner, sandbox: id };
    const fence = await this.operations.generation(scope);
    await this.operations.admit(fence, operationId, "create", { image });
    const sandbox = await this.state.transaction((tx) => {
      const previous = tx.get<Sandbox>(this.key(scope));
      if (previous) {
        if (
          previous.image !== image ||
          previous.createOperation !== operationId
        )
          throw new Error("Sandbox identity conflict");
        return previous;
      }
      const record: Sandbox = {
        id,
        owner,
        image,
        createOperation: operationId,
        placementOperation: operationId,
        restoreCheckpoint: null,
        pendingResume: null,
        phase: "queued",
        lease: null,
        checkpoint: null,
        generation: 1,
      };
      tx.put(this.key(scope), record);
      return record;
    });
    if (
      sandbox.phase === "queued" &&
      sandbox.placementOperation === operationId
    )
      await this.pool.enqueue(owner, id, operationId, { image });
    return sandbox;
  }
  async get(scope: Scope): Promise<Sandbox | undefined> {
    return this.state.transaction((tx) => tx.get<Sandbox>(this.key(scope)));
  }
  async list(owner: string): Promise<Sandbox[]> {
    identifier(owner);
    return this.state.transaction((tx) =>
      tx.scan<Sandbox>(`sandbox/${owner}/`).map((row) => row.value),
    );
  }
  async operation(scope: Scope, id: string) {
    return this.operations.get(scope, id);
  }
  async owners(): Promise<string[]> {
    return this.state.transaction((tx) => [
      ...new Set(tx.scan<Sandbox>("sandbox/").map((row) => row.value.owner)),
    ]);
  }
  private async request(
    lease: HostLease,
    action: string,
    payload: Json,
  ): Promise<Json> {
    return (
      await this.transport.request(lease.machineId, {
        version: HOST_PROTOCOL_VERSION,
        id: crypto.randomUUID(),
        action,
        payload,
      })
    ).result;
  }
  private async recoverObservedCreates(owner: string): Promise<void> {
    for (const slot of await this.pool.inspect(owner)) {
      const lease = slot.lease;
      if (!lease || !["assigned", "active", "quarantined"].includes(slot.phase))
        continue;
      const scope = { owner, sandbox: lease.sandboxId };
      const sandbox = await this.get(scope);
      if (!sandbox?.lease || canonical(sandbox.lease) !== canonical(lease))
        continue;
      const operation = await this.operations.get(
        scope,
        sandbox.placementOperation,
      );
      if (!operation || ["succeeded", "failed"].includes(operation.phase))
        continue;
      let observed: Json;
      try {
        observed = await this.request(lease, "inspect", { lease });
      } catch {
        continue;
      }
      if (
        !observed ||
        typeof observed !== "object" ||
        Array.isArray(observed) ||
        observed.phase !== "open" ||
        !observed.lease ||
        canonical(observed.lease) !== canonical(lease)
      )
        continue;
      // An absent runtime receipt proves no container creation was admitted.
      // File import is replayable by checkpoint identity and durable byte offset;
      // a creating/uncertain runtime receipt is never redispatched here.
      if (observed.runtime === undefined || observed.runtime === null) {
        if (sandbox.restoreCheckpoint)
          await restoreCheckpoint(
            this.objects,
            this.checkpoints,
            { ...scope, generation: sandbox.generation },
            sandbox.restoreCheckpoint,
            (action, payload) =>
              this.request(lease, action, {
                ...(payload as Record<string, Json>),
                lease,
                image: sandbox.image,
              }),
          );
        await this.request(lease, "create", { lease, image: sandbox.image });
        observed = await this.request(lease, "inspect", { lease });
        if (
          !observed ||
          typeof observed !== "object" ||
          Array.isArray(observed) ||
          observed.phase !== "open" ||
          canonical(observed.lease ?? null) !== canonical(lease)
        )
          continue;
      }
      const runtime = observed.runtime;
      if (
        !runtime ||
        typeof runtime !== "object" ||
        Array.isArray(runtime) ||
        runtime.phase !== "running" ||
        runtime.image !== sandbox.image
      )
        continue;
      const fence = await this.operations.generation(scope);
      if (operation.phase === "queued")
        await this.operations.claim(fence, operation.id);
      await this.pool.transition(lease, "active");
      await this.state.transaction((tx) => {
        const current = tx.get<Sandbox>(this.key(scope));
        if (!current?.lease || canonical(current.lease) !== canonical(lease))
          throw new Error("Recovery assignment changed");
        tx.put(this.key(scope), { ...current, phase: "running" });
      });
      await this.operations.finish(fence, operation.id, {
        phase: "succeeded",
        result: { sandboxId: sandbox.id },
        error: null,
      });
    }
  }
  private async retireIdleHosts(owner: string): Promise<void> {
    for (let slot of await this.pool.inspect(owner)) {
      if (slot.lease || !slot.machineId) continue;
      if (
        slot.phase === "idle" &&
        (slot.expiresAt <= this.now() ||
          (slot.idleSince !== null &&
            slot.idleSince + DEFAULTS.idleMs <= this.now()))
      )
        slot = await this.pool.retireIdle(slot.id);
      if (slot.phase !== "quarantined" || !slot.machineId) continue;
      // Allocation identity fences provider retries. SSH releases only its
      // adoption record; cloud adapters must acknowledge actual retirement.
      await this.provider.retire(slot.machineId, slot.allocationId);
      await this.pool.retired(slot.id);
    }
  }
  /** Pending placement and running receipts survive restarts. Unknown remote
   * effects quarantine the source; they never trigger a second allocation. */
  async reconcile(owner: string): Promise<void> {
    if (this.activeOwners.has(owner)) return;
    this.activeOwners.add(owner);
    try {
      await this.recoverObservedCreates(owner);
      await this.shutdown.reconcile(owner);
      await this.reconcileHeldResumes(owner);
      await this.retireIdleHosts(owner);
      // Repair admission interrupted between sandbox, operation and queue commits.
      for (const sandbox of await this.list(owner))
        if (sandbox.phase === "queued") {
          const scope = { owner, sandbox: sandbox.id };
          const fence = await this.operations.generation(scope);
          await this.operations.admit(
            fence,
            sandbox.placementOperation,
            sandbox.restoreCheckpoint ? "resume" : "create",
            sandbox.restoreCheckpoint
              ? { checkpointId: sandbox.restoreCheckpoint }
              : { image: sandbox.image },
          );
          await this.pool.enqueue(
            owner,
            sandbox.id,
            sandbox.placementOperation,
            { image: sandbox.image },
          );
        }
      const reservation = await this.pool.reserve(owner);
      if (reservation) {
        const allocated = await this.provider.allocate({
          owner,
          operationId: reservation.allocationId,
          expiresAt: reservation.expiresAt,
        });
        if ((await this.provider.inspect(allocated.id)).state !== "ready")
          return;
        await this.pool.provisioned(
          reservation.id,
          owner,
          allocated.id,
          allocated.allocationId,
        );
      }
      const assignment = await this.pool.assign(owner);
      if (!assignment) return;
      const { lease, ticket } = assignment;
      const scope = { owner, sandbox: ticket.sandboxId };
      const sandbox = await this.get(scope);
      if (!sandbox) throw new Error("Placement sandbox missing");
      const operationFence = await this.operations.generation(scope);
      if (!(await this.operations.claim(operationFence, ticket.id))) {
        await this.pool.transition(lease, "quarantined");
        return;
      }
      await this.state.transaction((tx) =>
        tx.put(this.key(scope), { ...sandbox, phase: "starting", lease }),
      );
      try {
        await this.checkpoints.initialize({
          ...scope,
          generation: sandbox.generation,
        });
        await this.request(lease, "claim", { lease });
        if (sandbox.restoreCheckpoint)
          await restoreCheckpoint(
            this.objects,
            this.checkpoints,
            { ...scope, generation: sandbox.generation },
            sandbox.restoreCheckpoint,
            (action, payload) =>
              this.request(lease, action, {
                ...(payload as Record<string, Json>),
                lease,
                image: sandbox.image,
              }),
          );
        await this.request(lease, "create", { lease, image: sandbox.image });
        await this.pool.transition(lease, "active");
        await this.state.transaction((tx) => {
          const current = tx.get<Sandbox>(this.key(scope));
          if (!current?.lease || canonical(current.lease) !== canonical(lease))
            throw new Error("Sandbox assignment changed");
          tx.put(this.key(scope), { ...current, phase: "running" });
        });
        await this.operations.finish(operationFence, ticket.id, {
          phase: "succeeded",
          result: { sandboxId: sandbox.id },
          error: null,
        });
      } catch (error) {
        await this.pool.transition(lease, "quarantined");
        await this.state.transaction((tx) => {
          const current = tx.get<Sandbox>(this.key(scope));
          if (current?.lease && canonical(current.lease) === canonical(lease))
            tx.put(this.key(scope), { ...current, phase: "quarantined" });
        });
        await this.operations.finish(operationFence, ticket.id, {
          phase: "uncertain",
          result: null,
          error: "Host lifecycle requires reconciliation",
        });
        throw error;
      }
    } finally {
      this.activeOwners.delete(owner);
    }
  }
  private async reconcileHeldResumes(owner: string) {
    const pending = await this.state.transaction((tx) =>
      tx
        .scan<ResumeRecord>(`resume/${owner}/`)
        .filter((row) => !row.value.placed),
    );
    for (const row of pending) {
      const [, recordOwner, sandboxId, id] = row.key.split("/");
      if (!recordOwner || !sandboxId || !id || !row.value.releaseId)
        throw Error("Invalid resume intent");
      const scope = { owner: recordOwner, sandbox: sandboxId };
      const release = await this.operations.get(scope, row.value.releaseId);
      if (release?.phase !== "succeeded") continue;
      await this.state.transaction((tx) => {
        const intent = tx.get<ResumeRecord>(row.key);
        if (!intent || intent.placed) return;
        const sandbox = tx.get<Sandbox>(this.key(scope));
        if (
          !sandbox ||
          sandbox.phase !== "stopped" ||
          sandbox.lease ||
          sandbox.pendingResume !== id ||
          sandbox.generation !== intent.generation ||
          sandbox.checkpoint !== intent.releaseId
        )
          throw Error("Resume release authority changed");
        const fence = { ...scope, generation: intent.generation };
        const next = this.checkpoints.advanceIn(tx, fence);
        this.operations.advanceIn(tx, fence);
        this.operations.rebaseQueuedIn(tx, next, id, fence.generation);
        tx.put(row.key, {
          ...intent,
          generation: next.generation,
          placed: true,
        });
        tx.put(this.key(scope), {
          ...sandbox,
          phase: "queued",
          generation: next.generation,
          placementOperation: id,
          restoreCheckpoint: intent.checkpointId,
          pendingResume: null,
        });
      });
    }
  }
  async resume(scope: Scope, id: string) {
    this.uuid(id);
    await this.state.transaction((tx) => {
      const prior = tx.get<ResumeRecord>(`resume/${scopeKey(scope)}/${id}`);
      if (prior) return prior;
      const sandbox = tx.get<Sandbox>(this.key(scope));
      if (
        !sandbox ||
        sandbox.phase !== "stopped" ||
        sandbox.pendingResume ||
        !sandbox.checkpoint
      )
        throw Error("Resume requires a durably released checkpoint");
      const fence = { ...scope, generation: sandbox.generation };
      if (sandbox.lease) {
        const releaseId = crypto.randomUUID();
        this.operations.admitIn(tx, fence, id, "resume", {
          checkpointId: sandbox.checkpoint,
        });
        this.shutdown.admitIn(tx, fence, releaseId, "stop");
        const current = tx.get<Sandbox>(this.key(scope))!;
        tx.put(this.key(scope), { ...current, pendingResume: id });
        const record: ResumeRecord = {
          generation: fence.generation,
          checkpointId: sandbox.checkpoint,
          releaseId,
          placed: false,
        };
        tx.put(`resume/${scopeKey(scope)}/${id}`, record);
        return record;
      }
      const next = this.checkpoints.advanceIn(tx, fence);
      this.operations.advanceIn(tx, fence);
      this.operations.admitIn(tx, next, id, "resume", {
        checkpointId: sandbox.checkpoint,
      });
      const record = {
        generation: next.generation,
        checkpointId: sandbox.checkpoint,
        releaseId: null,
        placed: true,
      };
      tx.put(`resume/${scopeKey(scope)}/${id}`, record);
      tx.put(this.key(scope), {
        ...sandbox,
        generation: next.generation,
        phase: "queued",
        placementOperation: id,
        restoreCheckpoint: sandbox.checkpoint,
      });
      return record;
    });
    return this.get(scope);
  }
  async deleteSandbox(scope: Scope, id: string) {
    this.uuid(id);
    const sandbox = await this.get(scope);
    if (!sandbox) throw Error("Sandbox unavailable");
    if (sandbox.pendingResume) throw Error("Resume transition pending");
    if (sandbox.lease) return this.shutdown.admit(scope, id, "delete");
    const fence = await this.operations.generation(scope);
    return this.state.transaction((tx) => {
      const current = tx.get<Sandbox>(this.key(scope));
      if (
        !current ||
        current.lease ||
        current.pendingResume ||
        !["stopped", "deleted"].includes(current.phase)
      )
        throw Error("Sandbox deletion requires resolved placement");
      const operation = this.operations.admitIn(tx, fence, id, "delete", {});
      if (operation.phase === "succeeded") return operation;
      this.operations.claimIn(tx, fence, id);
      tx.put(this.key(scope), { ...current, phase: "deleted" });
      return this.operations.finishIn(tx, fence, id, {
        phase: "succeeded",
        result: { checkpointId: current.checkpoint },
        error: null,
      });
    });
  }
  async stop(scope: Scope, id: string, mode: ShutdownMode = "stop") {
    this.uuid(id);
    if (mode !== "stop" && mode !== "checkpoint")
      throw Error("Invalid shutdown mode");
    return this.shutdown.admit(scope, id, mode);
  }
  async startCommand(
    scope: Scope,
    id: string,
    argv: string[],
    cwd = "/workspace",
    timeout = 120,
  ): Promise<Json> {
    this.uuid(id);
    const spec = { argv, cwd, timeout };
    const admission = await this.state.transaction((tx) => {
      const key = `command/${scopeKey(scope)}/${id}`;
      const prior = tx.get<CommandRecord>(key);
      if (prior) {
        if (canonical(prior.spec) !== canonical(spec))
          throw new Error("Command identity conflict");
        return { record: prior, fresh: false };
      }
      const sandbox = tx.get<Sandbox>(this.key(scope));
      if (!sandbox?.lease || sandbox.phase !== "running")
        throw new Error("Sandbox not running");
      const record: CommandRecord = {
        id,
        lease: sandbox.lease,
        image: sandbox.image,
        spec,
      };
      tx.put(key, record);
      return { record, fresh: true };
    });
    // Persist before crossing the host boundary. Even a controller crash before
    // dispatch is uncertain: reconnect observes this ID and never reexecutes it.
    if (!admission.fresh) return this.commandStatus(scope, id);
    return this.request(admission.record.lease, "command-start", {
      lease: admission.record.lease,
      image: admission.record.image,
      commandId: id,
      ...spec,
    });
  }
  private async command(scope: Scope, id: string) {
    this.uuid(id);
    const command = await this.state.transaction((tx) =>
      tx.get<CommandRecord>(`command/${scopeKey(scope)}/${id}`),
    );
    if (!command) throw new Error("Command unavailable");
    return command;
  }
  async commandStatus(scope: Scope, id: string): Promise<Json> {
    const command = await this.command(scope, id);
    const sandbox = await this.get(scope);
    if (!sandbox) throw new Error("Sandbox unavailable");
    const retained = await this.outputs.retained(
      { ...scope, generation: sandbox.generation },
      id,
    );
    if (retained !== undefined) return retained;
    return this.request(command.lease, "command-status", {
      lease: command.lease,
      image: command.image,
      commandId: id,
    });
  }
  /** Called by lifecycle reconciliation before host release. A failed transfer
   * keeps its writer admission, preventing collection and successful release. */
  async retainCommand(scope: Scope, id: string): Promise<void> {
    const command = await this.command(scope, id);
    const sandbox = await this.get(scope);
    if (!sandbox) throw new Error("Sandbox unavailable");
    const status = await this.commandStatus(scope, id);
    await this.outputs.retain(
      { ...scope, generation: sandbox.generation },
      id,
      status,
      (channel, offset, bytes) =>
        this.request(command.lease, "command-output", {
          lease: command.lease,
          image: command.image,
          commandId: id,
          channel,
          offset,
          bytes,
        }),
    );
  }
  async commandOutput(
    scope: Scope,
    id: string,
    channel: OutputChannel,
    offset: number,
    bytes: number,
  ): Promise<Json> {
    const command = await this.command(scope, id);
    const sandbox = await this.get(scope);
    if (!sandbox) throw new Error("Sandbox unavailable");
    const fence = { ...scope, generation: sandbox.generation };
    if ((await this.outputs.retained(fence, id)) !== undefined)
      return this.outputs.read(fence, id, channel, offset, bytes);
    return this.request(command.lease, "command-output", {
      lease: command.lease,
      image: command.image,
      commandId: id,
      channel,
      offset,
      bytes,
    });
  }
}
