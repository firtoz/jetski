import { CheckpointRegistry } from "./checkpoints.js";
import {
  type CheckpointStore,
  canonical,
  type HostProvider,
  identifier,
  type Json,
  type Scope,
  type StateStore,
  scopeKey,
} from "./contracts.js";
import { OperationJournal } from "./operations.js";
import { type HostLease, PoolJournal } from "./pool.js";
import { HOST_PROTOCOL_VERSION, type HostTransport } from "./transport.js";

export type Sandbox = {
  id: string;
  owner: string;
  image: string;
  createOperation: string;
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
export type ManagerOptions = {
  poolId: string;
  approvedImages: string[];
  hostsPerOwner?: number;
};

/** Portable lifecycle coordinator; all principal scope is supplied by the caller's
 * identity boundary. Private host-control methods are never public API routes. */
export class SandboxManager {
  private readonly pool: PoolJournal;
  private readonly operations: OperationJournal;
  private readonly checkpoints: CheckpointRegistry;
  private readonly activeOwners = new Set<string>();
  private readonly images: Set<string>;
  constructor(
    private readonly state: StateStore,
    private readonly provider: HostProvider,
    private readonly transport: HostTransport,
    objects: CheckpointStore,
    options: ManagerOptions,
  ) {
    this.pool = new PoolJournal(
      state,
      options.poolId,
      Date.now,
      () => crypto.randomUUID(),
      options.hostsPerOwner ?? 1,
    );
    this.operations = new OperationJournal(state);
    this.checkpoints = new CheckpointRegistry(state, objects);
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
        phase: "queued",
        lease: null,
        checkpoint: null,
        generation: 1,
      };
      tx.put(this.key(scope), record);
      return record;
    });
    if (sandbox.phase === "queued")
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
        sandbox.createOperation,
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
  /** Pending placement and running receipts survive restarts. Unknown remote
   * effects quarantine the source; they never trigger a second allocation. */
  async reconcile(owner: string): Promise<void> {
    if (this.activeOwners.has(owner)) return;
    this.activeOwners.add(owner);
    try {
      await this.recoverObservedCreates(owner);
      // Repair admission interrupted between the sandbox and queue transactions.
      for (const sandbox of await this.list(owner))
        if (sandbox.phase === "queued")
          await this.pool.enqueue(owner, sandbox.id, sandbox.createOperation, {
            image: sandbox.image,
          });
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
  async startCommand(
    scope: Scope,
    id: string,
    argv: string[],
    cwd = "/workspace",
    timeout = 120,
  ): Promise<Json> {
    this.uuid(id);
    const sandbox = await this.get(scope);
    if (!sandbox?.lease || sandbox.phase !== "running")
      throw new Error("Sandbox not running");
    // Host admission is idempotent on this exact ID and specification. A transport
    // failure is observed by ID; the SDK must not choose a replacement command ID.
    return this.request(sandbox.lease, "command-start", {
      lease: sandbox.lease,
      image: sandbox.image,
      commandId: id,
      argv,
      cwd,
      timeout,
    });
  }
  async commandStatus(scope: Scope, id: string): Promise<Json> {
    this.uuid(id);
    const sandbox = await this.get(scope);
    if (!sandbox?.lease) throw new Error("Sandbox unavailable");
    return this.request(sandbox.lease, "command-status", {
      lease: sandbox.lease,
      image: sandbox.image,
      commandId: id,
    });
  }
  async commandOutput(
    scope: Scope,
    id: string,
    channel: "stdout" | "stderr",
    offset: number,
    bytes: number,
  ): Promise<Json> {
    this.uuid(id);
    const sandbox = await this.get(scope);
    if (!sandbox?.lease) throw new Error("Sandbox unavailable");
    return this.request(sandbox.lease, "command-output", {
      lease: sandbox.lease,
      image: sandbox.image,
      commandId: id,
      channel,
      offset,
      bytes,
    });
  }
}
