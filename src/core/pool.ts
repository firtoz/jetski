import {
  canonical,
  DEFAULTS,
  identifier,
  type Json,
  type StateStore,
  type Transaction,
} from "./contracts.js";
import {
  decideIdleRetention,
  HOST_LIFECYCLE_LIMITS,
  type HostLifecycle,
  hostLifecycle,
  type IdleDecision,
  type IdlePriceQuote,
  idlePriceQuote,
} from "./host-lifecycle.js";
import type { HostIdleMode } from "./host-power.js";

export const MAX_HOST_STARTUP_CONCURRENCY = 16;
export const HOST_STARTUP_READY_PROBES = 40;
export const HOST_STARTUP_READY_POLL_MS = 250;

export type HostLease = {
  owner: string;
  poolId: string;
  slotId: string;
  machineId: string;
  sandboxId: string;
  assignmentId: string;
  generation: number;
};
export type HostPreparation = {
  id: string;
  owner: string;
  count: number;
  slots: string[];
  machines: string[];
  phase: "pending" | "ready" | "cancelled" | "expired";
  requestedAt: number;
  expiresAt: number;
};
const PREPARATION_DEADLINE_MS = 15 * 60_000;

export type PoolSlot = {
  preparationId?: string;
  nativePower?: {
    mode: HostIdleMode;
    phase: "sleeping" | "asleep" | "waking";
    operationId: string;
  };
  id: string;
  owner: string;
  allocationId: string;
  dispatched: boolean;
  machineId: string | null;
  phase:
    | "allocating"
    | "idle"
    | "assigned"
    | "active"
    | "quiescing"
    | "quarantined"
    | "retired";
  lease: HostLease | null;
  expiresAt: number;
  idleSince: number | null;
  /** Existing published slots without these fields retain the fixed v1 policy. */
  lifecycle?: HostLifecycle;
  idleDecision?: IdleDecision;
};
type Ticket = {
  id: string;
  owner: string;
  sandboxId: string;
  input: Json;
  phase: "queued" | "assigned" | "finished";
  sequence: number;
};
type Machine = {
  owner: string;
  fenceId: string;
  generation: number;
  slot: string | null;
};

export class InsufficientHostLifetimeError extends Error {
  constructor() {
    super("Insufficient host lifetime for command and checkpoint drain");
  }
}

/** Durable placement ledger. External effects never run inside transactions.
 * Lifecycle coordination must verify checkpoint publication and host cleanup
 * before calling release; this module does not itself perform either effect. */
export class PoolJournal {
  private readonly lifecycle: HostLifecycle;
  constructor(
    private readonly state: StateStore,
    readonly poolId: string,
    private readonly now = Date.now,
    private readonly newId = () => crypto.randomUUID(),
    private readonly capacity: number = DEFAULTS.hostsPerOwner,
    lifecycle?: HostLifecycle,
  ) {
    identifier(poolId);
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 64)
      throw new Error("Invalid owner capacity");
    this.lifecycle = hostLifecycle(lifecycle);
  }
  drainAt(slot: PoolSlot): number {
    return slot.expiresAt - hostLifecycle(slot.lifecycle).drainMs;
  }
  idleRetireAt(slot: PoolSlot): number {
    if (slot.idleSince === null) return this.drainAt(slot);
    const decision =
      slot.idleDecision ??
      decideIdleRetention({
        policy: hostLifecycle(slot.lifecycle),
        idleSince: slot.idleSince,
        expiresAt: slot.expiresAt,
        returnGapsMs: [],
      });
    return Math.min(this.drainAt(slot), decision.retireAt);
  }
  /** Trusted embedding supplies account pricing outside its state transactions.
   * Updating a quote does not silently extend an existing idle decision. */
  async setIdlePriceQuote(owner: string, input: IdlePriceQuote): Promise<void> {
    identifier(owner);
    const quote = idlePriceQuote(input);
    await this.state.transaction((tx) => {
      const key = `${this.prefix()}price/${owner}`;
      const prior = tx.get<IdlePriceQuote>(key);
      if (prior && prior.observedAt > quote.observedAt)
        throw Error("Stale idle price quote");
      if (
        prior &&
        prior.observedAt === quote.observedAt &&
        canonical(prior) !== canonical(quote)
      )
        throw Error("Idle price quote identity conflict");
      tx.put(key, quote);
    });
  }
  async claimIdlePriceRefresh(owner: string): Promise<string | undefined> {
    identifier(owner);
    return this.state.transaction((tx) => {
      const now = this.now();
      const quote = tx.get<IdlePriceQuote>(`${this.prefix()}price/${owner}`);
      if (quote && quote.observedAt <= now && quote.validUntil > now) return;
      const key = `${this.prefix()}price-refresh/${owner}`;
      const prior = tx.get<{ id: string; until: number }>(key);
      if (prior && prior.until > now) return;
      const id = this.newId();
      tx.put(key, { id, until: now + HOST_LIFECYCLE_LIMITS.priceRetryMs });
      return id;
    });
  }
  async finishIdlePriceRefresh(
    owner: string,
    id: string,
    input?: IdlePriceQuote,
  ): Promise<boolean> {
    const quote = input === undefined ? undefined : idlePriceQuote(input);
    return this.state.transaction((tx) => {
      const now = this.now(),
        key = `${this.prefix()}price-refresh/${identifier(owner)}`;
      const claim = tx.get<{ id: string; until: number }>(key);
      if (!claim || claim.id !== id || claim.until <= now) return false;
      tx.put(key, { id, until: now + HOST_LIFECYCLE_LIMITS.priceRetryMs });
      if (!quote || quote.observedAt > now || quote.validUntil <= now)
        return false;
      const priceKey = `${this.prefix()}price/${owner}`,
        prior = tx.get<IdlePriceQuote>(priceKey);
      if (
        prior &&
        (prior.observedAt > quote.observedAt ||
          (prior.observedAt === quote.observedAt &&
            canonical(prior) !== canonical(quote)))
      )
        return false;
      tx.put(priceKey, quote);
      return true;
    });
  }
  private idleIn(tx: Transaction, slot: PoolSlot, at: number): IdleDecision {
    const history = tx.get<{ lastReleaseAt: number | null; gaps: number[] }>(
      `${this.prefix()}returns/${slot.owner}`,
    );
    return decideIdleRetention({
      policy: hostLifecycle(slot.lifecycle),
      idleSince: at,
      expiresAt: slot.expiresAt,
      returnGapsMs: history?.gaps ?? [],
      quote: tx.get<IdlePriceQuote>(`${this.prefix()}price/${slot.owner}`),
    });
  }
  /** Durable admission fences placement across native power network effects. */
  async claimNativePower(
    observed: PoolSlot,
    waking: boolean,
  ): Promise<PoolSlot | undefined> {
    return this.state.transaction((tx) => {
      const slot = tx.get<PoolSlot>(this.slotKey(observed.id));
      if (
        !slot ||
        canonical(slot) !== canonical(observed) ||
        slot.phase !== "idle" ||
        slot.lease ||
        !slot.machineId ||
        this.drainAt(slot) <= this.now()
      )
        return;
      const queued = tx
        .scan<Ticket>(`${this.prefix()}ticket/${slot.owner}/`)
        .some((r) => r.value.phase === "queued");
      if (waking) {
        if (!queued || slot.nativePower?.phase !== "asleep") return;
        const next = {
          ...slot,
          nativePower: {
            ...slot.nativePower,
            phase: "waking" as const,
            operationId: this.newId(),
          },
        };
        tx.put(this.slotKey(slot.id), next);
        return next;
      }
      const policy = slot.lifecycle?.nativeIdle;
      if (
        queued ||
        slot.nativePower ||
        !policy ||
        slot.idleSince === null ||
        slot.idleSince + policy.afterMs > this.now() ||
        this.idleRetireAt(slot) <= this.now()
      )
        return;
      const next = {
        ...slot,
        nativePower: {
          mode: policy.mode,
          phase: "sleeping" as const,
          operationId: this.newId(),
        },
      };
      tx.put(this.slotKey(slot.id), next);
      return next;
    });
  }
  async finishNativePower(observed: PoolSlot): Promise<void> {
    await this.state.transaction((tx) => {
      const slot = tx.get<PoolSlot>(this.slotKey(observed.id));
      if (
        !slot ||
        canonical(slot) !== canonical(observed) ||
        slot.phase !== "idle" ||
        slot.lease ||
        !slot.nativePower
      )
        throw Error("Native power receipt fenced");
      if (slot.nativePower.phase === "sleeping")
        tx.put(this.slotKey(slot.id), {
          ...slot,
          nativePower: { ...slot.nativePower, phase: "asleep" },
        });
      else if (slot.nativePower.phase === "waking") {
        const { nativePower: _power, ...awake } = slot;
        tx.put(this.slotKey(slot.id), awake);
      } else throw Error("Native power transition not admitted");
    });
  }
  async nextMaintenanceAt(owner: string): Promise<number | null> {
    return this.state.transaction((tx) => {
      const waiting = tx
        .scan<Ticket>(`${this.prefix()}ticket/${identifier(owner)}/`)
        .some((row) => row.value.phase === "queued");
      const deadlines = this.slots(tx, owner)
        .filter((slot) => slot.phase !== "retired")
        .map((slot) => {
          if (
            slot.nativePower &&
            (slot.nativePower.phase !== "asleep" || waiting)
          )
            return this.now() + HOST_LIFECYCLE_LIMITS.maintenanceRetryMs;
          if (slot.phase === "idle" && !waiting) {
            const sleep = slot.lifecycle?.nativeIdle;
            if (sleep && !slot.nativePower && slot.idleSince !== null)
              return Math.min(
                this.idleRetireAt(slot),
                slot.idleSince + sleep.afterMs,
              );
            return this.idleRetireAt(slot);
          }
          return this.drainAt(slot);
        });
      if (
        tx
          .scan<HostPreparation>(`${this.prefix()}preparation/${owner}/`)
          .some((row) => row.value.phase === "pending")
      )
        deadlines.push(this.now() + HOST_LIFECYCLE_LIMITS.maintenanceRetryMs);
      return deadlines.length
        ? Math.max(
            this.now() + HOST_LIFECYCLE_LIMITS.maintenanceRetryMs,
            Math.min(...deadlines),
          )
        : null;
    });
  }
  private prefix() {
    return `pool/${this.poolId}/`;
  }
  private slots(tx: Transaction, owner: string) {
    return tx
      .scan<PoolSlot>(`${this.prefix()}slot/`)
      .map((row) => row.value)
      .filter((slot) => slot.owner === owner);
  }
  private slotKey(id: string) {
    return `${this.prefix()}slot/${identifier(id)}`;
  }
  private ticketKey(owner: string, id: string) {
    return `${this.prefix()}ticket/${identifier(owner)}/${identifier(id)}`;
  }
  private machineKey(id: string) {
    return `${this.prefix()}machine/${identifier(id)}`;
  }
  private exact(tx: Transaction, lease: HostLease): PoolSlot {
    if (lease.poolId !== this.poolId) throw new Error("Pool mismatch");
    const machine = tx.get<Machine>(this.machineKey(lease.machineId));
    const slot = machine?.slot
      ? tx.get<PoolSlot>(this.slotKey(machine.slot))
      : undefined;
    if (!slot || !slot.lease || canonical(slot.lease) !== canonical(lease))
      throw new Error("Stale host lease");
    return slot;
  }
  /** Check in the same transaction that persists command admission. */
  admitExecutionIn(
    tx: Transaction,
    lease: HostLease,
    timeoutSeconds: number,
  ): void {
    if (
      !Number.isSafeInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > 3600
    )
      throw new Error("Invalid command timeout");
    const slot = this.exact(tx, lease);
    if (slot.phase !== "active") throw new Error("Host assignment not active");
    if (
      slot.expiresAt <=
      this.now() + timeoutSeconds * 1000 + hostLifecycle(slot.lifecycle).drainMs
    )
      throw new InsufficientHostLifetimeError();
  }
  async enqueue(
    owner: string,
    sandboxId: string,
    id: string,
    input: Json,
  ): Promise<Ticket> {
    return this.state.transaction((tx) =>
      this.enqueueIn(tx, owner, sandboxId, id, input),
    );
  }
  enqueueIn(
    tx: Transaction,
    owner: string,
    sandboxId: string,
    id: string,
    input: Json,
  ): Ticket {
    identifier(owner);
    identifier(sandboxId);
    identifier(id);
    const encoded = canonical(input);
    if (encoded.length > 65536) throw new Error("Placement input bound");
    const key = this.ticketKey(owner, id),
      previous = tx.get<Ticket>(key);
    if (previous) {
      if (
        previous.sandboxId !== sandboxId ||
        canonical(previous.input) !== encoded
      )
        throw new Error("Placement identity conflict");
      return previous;
    }
    const queued = tx
      .scan<Ticket>(`${this.prefix()}ticket/${owner}/`)
      .filter((row) => row.value.phase !== "finished");
    if (queued.length >= 1024) throw new Error("Owner queue bound");
    if (queued.some((row) => row.value.sandboxId === sandboxId))
      throw new Error("Sandbox already has an active placement");
    const sequenceKey = `${this.prefix()}sequence`;
    const sequence = (tx.get<number>(sequenceKey) ?? 0) + 1;
    if (!Number.isSafeInteger(sequence))
      throw new Error("Queue sequence exhausted");
    tx.put(sequenceKey, sequence);
    const ticket: Ticket = {
      id,
      owner,
      sandboxId,
      input: JSON.parse(encoded),
      phase: "queued",
      sequence,
    };
    tx.put(key, ticket);
    const historyKey = `${this.prefix()}returns/${owner}`;
    const history = tx.get<{ lastReleaseAt: number | null; gaps: number[] }>(
      historyKey,
    );
    if (
      history?.lastReleaseAt !== null &&
      history?.lastReleaseAt !== undefined
    ) {
      const gap = Math.max(0, this.now() - history.lastReleaseAt);
      tx.put(historyKey, {
        lastReleaseAt: null,
        gaps: [...history.gaps, gap].slice(
          -HOST_LIFECYCLE_LIMITS.historySamples,
        ),
      });
    }
    return ticket;
  }
  private preparationKey(owner: string, id: string) {
    return `${this.prefix()}preparation/${identifier(owner)}/${identifier(id)}`;
  }
  /** One-shot preparation, not a minimum-warm target. Replays never replenish
   * consumed hosts. No provider effect occurs in this transaction. */
  async prepare(
    owner: string,
    id: string,
    count: number,
  ): Promise<HostPreparation> {
    if (!Number.isSafeInteger(count) || count < 1 || count > this.capacity)
      throw Error("Preparation exceeds owner capacity");
    return this.state.transaction((tx) => {
      const key = this.preparationKey(owner, id);
      const prior = tx.get<HostPreparation>(key);
      if (prior) {
        if (prior.count !== count) throw Error("Preparation identity conflict");
        return prior;
      }
      const now = this.now();
      const slots = this.slots(tx, owner).filter((s) => s.phase !== "retired");
      const pending = tx
        .scan<HostPreparation>(`${this.prefix()}preparation/${owner}/`)
        .map((row) => row.value)
        .filter((p) => p.phase === "pending" && p.expiresAt > now);
      const claimed = new Set(pending.flatMap((p) => p.slots));
      const available = slots
        .filter(
          (s) =>
            s.phase === "idle" &&
            !s.nativePower &&
            !s.lease &&
            this.drainAt(s) > now &&
            this.idleRetireAt(s) > now &&
            !claimed.has(s.id),
        )
        .slice(0, count);
      if (slots.length + count - available.length > this.capacity)
        throw Error("Preparation exceeds available owner capacity");
      const expiresAt =
        now +
        Math.min(
          PREPARATION_DEADLINE_MS,
          this.lifecycle.lifetimeMs - this.lifecycle.drainMs,
        );
      while (available.length < count) {
        const slot: PoolSlot = {
          id: this.newId(),
          owner,
          allocationId: this.newId(),
          dispatched: false,
          machineId: null,
          phase: "allocating",
          lease: null,
          expiresAt: now + this.lifecycle.lifetimeMs,
          idleSince: null,
          lifecycle: hostLifecycle(this.lifecycle),
          preparationId: id,
        };
        tx.put(this.slotKey(slot.id), slot);
        available.push(slot);
      }
      const preparation: HostPreparation = {
        id,
        owner,
        count,
        slots: available.map((s) => s.id),
        machines: [],
        phase: "pending",
        requestedAt: now,
        expiresAt,
      };
      tx.put(key, preparation);
      return preparation;
    });
  }
  async preparation(owner: string, id: string): Promise<HostPreparation> {
    return this.state.transaction((tx) => {
      const result = tx.get<HostPreparation>(this.preparationKey(owner, id));
      if (!result) throw Error("Host preparation unavailable");
      return result;
    });
  }
  async hasPendingPreparation(owner: string): Promise<boolean> {
    identifier(owner);
    return this.state.transaction((tx) =>
      tx
        .scan<HostPreparation>(`${this.prefix()}preparation/${owner}/`)
        .some(
          (row) =>
            row.value.phase === "pending" && row.value.expiresAt > this.now(),
        ),
    );
  }
  async finishPreparations(
    owner: string,
    ready: ReadonlySet<string>,
  ): Promise<void> {
    identifier(owner);
    await this.state.transaction((tx) => {
      for (const { key, value: request } of tx.scan<HostPreparation>(
        `${this.prefix()}preparation/${owner}/`,
      )) {
        if (request.phase !== "pending") continue;
        if (request.expiresAt <= this.now()) {
          tx.put(key, { ...request, phase: "expired" });
          continue;
        }
        const slots = request.slots.map((id) =>
          tx.get<PoolSlot>(this.slotKey(id)),
        );
        if (
          slots.every(
            (s) =>
              s &&
              s.owner === owner &&
              s.phase === "idle" &&
              !s.lease &&
              !s.nativePower &&
              this.drainAt(s) > this.now() &&
              this.idleRetireAt(s) > this.now() &&
              s.machineId &&
              ready.has(s.id),
          )
        )
          tx.put(key, {
            ...request,
            phase: "ready",
            machines: slots.map((s) => s!.machineId!),
          });
      }
    });
  }
  async cancelPreparations(owner: string): Promise<void> {
    identifier(owner);
    await this.state.transaction((tx) => {
      for (const { key, value } of tx.scan<HostPreparation>(
        `${this.prefix()}preparation/${owner}/`,
      ))
        if (value.phase === "pending")
          tx.put(key, { ...value, phase: "cancelled" });
      for (const slot of this.slots(tx, owner))
        if (
          slot.phase === "allocating" &&
          slot.preparationId &&
          !slot.dispatched
        )
          tx.put(this.slotKey(slot.id), { ...slot, phase: "retired" });
    });
  }
  async reserve(owner: string): Promise<PoolSlot | undefined> {
    identifier(owner);
    return this.state.transaction((tx) => {
      const tickets = tx
        .scan<Ticket>(`${this.prefix()}ticket/${owner}/`)
        .map((row) => row.value)
        .filter((ticket) => ticket.phase === "queued");
      if (!tickets.length) return undefined;
      const slots = this.slots(tx, owner).filter(
        (slot) => slot.phase !== "retired",
      );
      const pending = slots.find((slot) => slot.phase === "allocating");
      if (pending) return pending;
      if (
        slots.some(
          (slot) => slot.phase === "idle" && this.drainAt(slot) > this.now(),
        ) ||
        slots.length >= this.capacity
      )
        return undefined;
      const slot: PoolSlot = {
        id: this.newId(),
        owner,
        allocationId: this.newId(),
        dispatched: false,
        machineId: null,
        phase: "allocating",
        lease: null,
        expiresAt: this.now() + this.lifecycle.lifetimeMs,
        idleSince: null,
        lifecycle: hostLifecycle(this.lifecycle),
      };
      tx.put(this.slotKey(slot.id), slot);
      return slot;
    });
  }
  /** Reserve only the deficit of queued demand after existing idle/pending hosts.
   * Replayed batches retain allocation IDs; concurrent controllers cannot inflate
   * capacity or allocate a second physical machine for the same reservation. */
  async reserveBatch(owner: string, limit: number): Promise<PoolSlot[]> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_HOST_STARTUP_CONCURRENCY
    )
      throw Error("Invalid host startup concurrency");
    if (limit === 1) {
      const pending = (await this.inspect(owner)).find(
        (slot) => slot.phase === "allocating",
      );
      const slot = pending ?? (await this.reserve(owner));
      return slot ? [slot] : [];
    }
    identifier(owner);
    return this.state.transaction((tx) => {
      const demand = tx
        .scan<Ticket>(`${this.prefix()}ticket/${owner}/`)
        .filter((row) => row.value.phase === "queued").length;
      const slots = this.slots(tx, owner).filter(
        (slot) => slot.phase !== "retired",
      );
      const pending = slots.filter((slot) => slot.phase === "allocating");
      const idle = slots.filter(
        (slot) =>
          slot.phase === "idle" &&
          !slot.lease &&
          this.drainAt(slot) > this.now(),
      ).length;
      const count = Math.max(
        0,
        Math.min(
          demand - pending.length - idle,
          limit - pending.length,
          this.capacity - slots.length,
        ),
      );
      for (let i = 0; i < count; i++) {
        const slot: PoolSlot = {
          id: this.newId(),
          owner,
          allocationId: this.newId(),
          dispatched: false,
          machineId: null,
          phase: "allocating",
          lease: null,
          expiresAt: this.now() + this.lifecycle.lifetimeMs,
          idleSince: null,
          lifecycle: hostLifecycle(this.lifecycle),
        };
        tx.put(this.slotKey(slot.id), slot);
        pending.push(slot);
      }
      return pending.sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit);
    });
  }
  cancelQueuedIn(
    tx: Transaction,
    owner: string,
    sandboxId: string,
    id: string,
    input: Json,
  ) {
    const key = this.ticketKey(owner, id),
      ticket = tx.get<Ticket>(key);
    if (
      ticket &&
      (ticket.sandboxId !== sandboxId ||
        canonical(ticket.input) !== canonical(input))
    )
      throw Error("Placement identity conflict");
    if (ticket?.phase === "assigned") throw Error("Placement already assigned");
    tx.put(
      key,
      ticket
        ? { ...ticket, phase: "finished" }
        : { id, owner, sandboxId, input, phase: "finished", sequence: 0 },
    );
  }
  async dispatchAllocation(
    id: string,
    owner: string,
  ): Promise<PoolSlot | undefined> {
    return this.state.transaction((tx) => {
      const slot = tx.get<PoolSlot>(this.slotKey(id));
      if (!slot || slot.owner !== owner || slot.phase !== "allocating")
        throw Error("Allocation reservation unavailable");
      if (slot.dispatched) return slot;
      const demand = tx
        .scan<Ticket>(`${this.prefix()}ticket/${owner}/`)
        .filter((row) => row.value.phase === "queued").length;
      const covered = this.slots(tx, owner).filter(
        (other) =>
          other.id !== slot.id &&
          ((other.phase === "allocating" && other.dispatched) ||
            (other.phase === "idle" &&
              !other.lease &&
              this.drainAt(other) > this.now())),
      ).length;
      const preparation = slot.preparationId
        ? tx.get<HostPreparation>(
            this.preparationKey(owner, slot.preparationId),
          )
        : undefined;
      const requested =
        preparation?.phase === "pending" && preparation.expiresAt > this.now();
      if (!requested && demand <= covered) {
        tx.put(this.slotKey(id), { ...slot, phase: "retired" });
        return undefined;
      }
      const next = { ...slot, dispatched: true };
      tx.put(this.slotKey(id), next);
      return next;
    });
  }
  async provisioned(
    id: string,
    owner: string,
    machineId: string,
    allocationId: string,
  ): Promise<PoolSlot> {
    identifier(machineId);
    return this.state.transaction((tx) => {
      const slot = tx.get<PoolSlot>(this.slotKey(id));
      if (!slot || slot.owner !== owner || slot.allocationId !== allocationId)
        throw new Error("Allocation identity mismatch");
      if (slot.machineId === machineId && slot.phase !== "allocating")
        return slot;
      if (slot.phase !== "allocating" || slot.machineId)
        throw new Error("Allocation already resolved");
      const key = this.machineKey(machineId),
        previous = tx.get<Machine>(key);
      if (
        previous &&
        (previous.owner !== owner ||
          (previous.slot !== null && previous.slot !== id))
      )
        throw new Error("Machine already bound");
      const machine: Machine = previous
        ? { ...previous, slot: id }
        : { owner, fenceId: this.newId(), generation: 0, slot: id };
      const next: PoolSlot = {
        ...slot,
        machineId,
        phase: "idle",
        idleSince: this.now(),
      };
      next.idleDecision = this.idleIn(tx, next, next.idleSince!);
      tx.put(key, machine);
      tx.put(this.slotKey(id), next);
      return next;
    });
  }
  async assign(
    owner: string,
    prepare?: (tx: Transaction, ticket: Ticket, lease: HostLease) => void,
    readySlots?: ReadonlySet<string>,
  ): Promise<{ ticket: Ticket; slot: PoolSlot; lease: HostLease } | undefined> {
    identifier(owner);
    return this.state.transaction((tx) => {
      const ticket = tx
        .scan<Ticket>(`${this.prefix()}ticket/${owner}/`)
        .map((row) => row.value)
        .filter((ticket) => ticket.phase === "queued")
        .sort((a, b) => a.sequence - b.sequence)[0];
      const slot = this.slots(tx, owner).find(
        (slot) =>
          slot.phase === "idle" &&
          !slot.nativePower &&
          (readySlots === undefined || readySlots.has(slot.id)) &&
          this.drainAt(slot) > this.now(),
      );
      if (!ticket || !slot || !slot.machineId) return undefined;
      const machine = tx.get<Machine>(this.machineKey(slot.machineId));
      if (
        !machine ||
        machine.slot !== slot.id ||
        machine.owner !== owner ||
        !Number.isSafeInteger(machine.generation + 1)
      )
        throw new Error("Machine authority mismatch");
      const lease: HostLease = {
        owner,
        poolId: this.poolId,
        slotId: machine.fenceId,
        machineId: slot.machineId,
        sandboxId: ticket.sandboxId,
        assignmentId: this.newId(),
        generation: machine.generation + 1,
      };
      const next: PoolSlot = {
        ...slot,
        phase: "assigned",
        lease,
        idleSince: null,
      };
      tx.put(this.machineKey(slot.machineId), {
        ...machine,
        generation: lease.generation,
      });
      tx.put(this.slotKey(slot.id), next);
      tx.put(this.ticketKey(owner, ticket.id), {
        ...ticket,
        phase: "assigned",
      });
      prepare?.(tx, ticket, lease);
      return { ticket, slot: next, lease };
    });
  }
  /** Reserve the same exclusive assignment under its next physical generation.
   * Caller blocks sandbox execution and retains the durable FS root in this tx. */
  reserveMemorySuccessorIn(
    tx: Transaction,
    lease: HostLease,
    id: string,
  ): HostLease {
    const key = `${this.prefix()}memory-resume/${identifier(lease.owner)}/${identifier(lease.sandboxId)}/${identifier(id)}`;
    const prior = tx.get<{ previous: HostLease; successor: HostLease }>(key);
    if (prior) {
      if (canonical(prior.previous) !== canonical(lease))
        throw Error("Memory lease identity conflict");
      this.exact(tx, prior.successor);
      return prior.successor;
    }
    const slot = this.exact(tx, lease);
    if (slot.phase !== "quiescing")
      throw Error("Memory source is not suspended");
    const machine = tx.get<Machine>(this.machineKey(lease.machineId));
    if (
      !machine ||
      machine.generation !== lease.generation ||
      !Number.isSafeInteger(lease.generation + 1)
    )
      throw Error("Memory machine generation mismatch");
    const successor = { ...lease, generation: lease.generation + 1 };
    tx.put(this.machineKey(lease.machineId), {
      ...machine,
      generation: successor.generation,
    });
    tx.put(this.slotKey(slot.id), { ...slot, lease: successor });
    tx.put(key, { previous: lease, successor });
    return successor;
  }
  /** Only after the host attests the exact successor and the root is verified. */
  activateMemorySuccessorIn(
    tx: Transaction,
    lease: HostLease,
    id: string,
  ): void {
    const receipt = tx.get<{ successor: HostLease }>(
      `${this.prefix()}memory-resume/${identifier(lease.owner)}/${identifier(lease.sandboxId)}/${identifier(id)}`,
    );
    if (!receipt || canonical(receipt.successor) !== canonical(lease))
      throw Error("Memory successor unavailable");
    const slot = this.exact(tx, lease);
    if (!["quiescing", "quarantined", "active"].includes(slot.phase))
      throw Error("Memory successor state changed");
    tx.put(this.slotKey(slot.id), { ...slot, phase: "active" });
  }
  /** After positive native absence/discard, prepare the reserved generation for release. */
  quiesceMemorySuccessorIn(
    tx: Transaction,
    lease: HostLease,
    id: string,
  ): void {
    const receipt = tx.get<{ successor: HostLease }>(
      `${this.prefix()}memory-resume/${identifier(lease.owner)}/${identifier(lease.sandboxId)}/${identifier(id)}`,
    );
    if (!receipt || canonical(receipt.successor) !== canonical(lease))
      throw Error("Memory successor unavailable");
    const slot = this.exact(tx, lease);
    if (!["quiescing", "quarantined"].includes(slot.phase))
      throw Error("Memory successor is not closed");
    tx.put(this.slotKey(slot.id), { ...slot, phase: "quiescing" });
  }
  async transition(
    lease: HostLease,
    to: "active" | "quiescing" | "quarantined",
  ): Promise<PoolSlot> {
    return this.state.transaction((tx) => {
      const slot = this.exact(tx, lease);
      if (slot.phase === to) return slot;
      if (
        to === "active" &&
        slot.phase !== "assigned" &&
        slot.phase !== "quarantined"
      )
        throw new Error("Invalid active transition");
      if (to === "quiescing" && slot.phase !== "active")
        throw new Error("Invalid stop transition");
      if (slot.phase === "idle" || slot.phase === "retired")
        throw new Error("Assignment unavailable");
      const next = { ...slot, phase: to };
      tx.put(this.slotKey(slot.id), next);
      return next;
    });
  }
  async release(lease: HostLease): Promise<void> {
    await this.state.transaction((tx) => this.releaseIn(tx, lease));
  }
  releaseIn(tx: Transaction, lease: HostLease): void {
    const receiptKey = `${this.prefix()}released/${identifier(lease.assignmentId)}`;
    const previous = tx.get<HostLease>(receiptKey);
    if (previous) {
      if (canonical(previous) !== canonical(lease))
        throw new Error("Release identity conflict");
      return;
    }
    const slot = this.exact(tx, lease);
    if (slot.phase !== "quiescing")
      throw new Error("Release requires quiescence");
    const ticket = tx
      .scan<Ticket>(`${this.prefix()}ticket/${lease.owner}/`)
      .map((row) => row.value)
      .find(
        (ticket) =>
          ticket.sandboxId === lease.sandboxId && ticket.phase === "assigned",
      );
    if (!ticket) throw new Error("Placement receipt missing");
    tx.put(this.ticketKey(ticket.owner, ticket.id), {
      ...ticket,
      phase: "finished",
    });
    tx.put(receiptKey, lease);
    const at = this.now();
    const historyKey = `${this.prefix()}returns/${lease.owner}`;
    const history = tx.get<{ lastReleaseAt: number | null; gaps: number[] }>(
      historyKey,
    );
    tx.put(historyKey, { lastReleaseAt: at, gaps: history?.gaps ?? [] });
    tx.put(this.slotKey(slot.id), {
      ...slot,
      phase: "idle",
      lease: null,
      idleSince: at,
      idleDecision: this.idleIn(tx, slot, at),
    });
  }
  /** The coordinator must positively observe provider absence first. A stale
   * observation cannot retire a host assigned while that request was in flight. */
  async retireMissingIdle(observed: PoolSlot): Promise<PoolSlot> {
    return this.state.transaction((tx) => {
      const slot = tx.get<PoolSlot>(this.slotKey(observed.id));
      if (
        !slot ||
        slot.phase !== "idle" ||
        slot.lease ||
        !slot.machineId ||
        canonical(slot) !== canonical(observed)
      )
        throw Error("Missing-host observation is stale");
      const next: PoolSlot = { ...slot, phase: "quarantined" };
      tx.put(this.slotKey(slot.id), next);
      return next;
    });
  }
  /** Explicit recovery only, after positive provider absence. Unlike release,
   * this records a lost source, never successful quiescence/publication. The
   * caller must fence sandbox and checkpoint state in the same transaction. */
  retireMissingAssignmentIn(
    tx: Transaction,
    lease: HostLease,
    placementId?: string,
  ): void {
    const slot = this.exact(tx, lease);
    if (!["quiescing", "quarantined"].includes(slot.phase))
      throw Error("Missing assignment not quarantined or stopping");
    const tickets = tx
      .scan<Ticket>(`${this.prefix()}ticket/${lease.owner}/`)
      .map((row) => row.value)
      .filter(
        (ticket) =>
          ticket.sandboxId === lease.sandboxId && ticket.phase === "assigned",
      );
    if (
      tickets.length !== 1 ||
      (placementId !== undefined && tickets[0]!.id !== placementId)
    )
      throw Error("Placement receipt ambiguous");
    const machine = tx.get<Machine>(this.machineKey(lease.machineId));
    if (!machine || machine.slot !== slot.id)
      throw Error("Machine authority mismatch");
    tx.put(this.ticketKey(lease.owner, tickets[0]!.id), {
      ...tickets[0]!,
      phase: "finished",
    });
    tx.put(this.machineKey(lease.machineId), { ...machine, slot: null });
    tx.put(this.slotKey(slot.id), { ...slot, phase: "retired", lease: null });
    tx.put(`${this.prefix()}lost/${identifier(lease.assignmentId)}`, lease);
  }
  async retireIdle(
    id: string,
    reason: "idle" | "shutdown" = "idle",
  ): Promise<PoolSlot> {
    return this.state.transaction((tx) => {
      const slot = tx.get<PoolSlot>(this.slotKey(id));
      if (!slot || slot.phase !== "idle" || slot.lease || !slot.machineId)
        throw new Error("Host not idle");
      if (reason === "idle" && this.idleRetireAt(slot) > this.now())
        throw new Error("Idle retention not elapsed");
      if (
        reason === "shutdown" &&
        tx
          .scan<Ticket>(`${this.prefix()}ticket/${slot.owner}/`)
          .some((row) => row.value.phase === "queued")
      )
        throw Error("Queued assignments prevent shutdown retirement");
      if (
        this.drainAt(slot) > this.now() &&
        tx
          .scan<Ticket>(`${this.prefix()}ticket/${slot.owner}/`)
          .some((row) => row.value.phase === "queued")
      )
        return slot;
      // Keep the machine binding until provider retirement is observed.
      const next: PoolSlot = { ...slot, phase: "quarantined" };
      tx.put(this.slotKey(id), next);
      return next;
    });
  }
  async retired(id: string): Promise<void> {
    await this.state.transaction((tx) => {
      const slot = tx.get<PoolSlot>(this.slotKey(id));
      if (slot?.phase === "retired") return;
      if (
        !slot ||
        slot.phase !== "quarantined" ||
        slot.lease ||
        !slot.machineId
      )
        throw new Error("Retirement not admitted");
      const key = this.machineKey(slot.machineId),
        machine = tx.get<Machine>(key);
      if (!machine || machine.slot !== id)
        throw new Error("Machine authority mismatch");
      tx.put(key, { ...machine, slot: null });
      tx.put(this.slotKey(id), { ...slot, phase: "retired" });
    });
  }
  async inspect(owner: string): Promise<PoolSlot[]> {
    identifier(owner);
    return this.state.transaction((tx) => this.slots(tx, owner));
  }
}
