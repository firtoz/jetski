import {
  canonical,
  DEFAULTS,
  identifier,
  type Json,
  type StateStore,
  type Transaction,
} from "./contracts.js";

export type HostLease = {
  owner: string;
  poolId: string;
  slotId: string;
  machineId: string;
  sandboxId: string;
  assignmentId: string;
  generation: number;
};
export type PoolSlot = {
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

/** Durable placement ledger. External effects never run inside transactions.
 * Lifecycle coordination must verify checkpoint publication and host cleanup
 * before calling release; this module does not itself perform either effect. */
export class PoolJournal {
  constructor(
    private readonly state: StateStore,
    readonly poolId: string,
    private readonly now = Date.now,
    private readonly newId = () => crypto.randomUUID(),
    private readonly capacity: number = DEFAULTS.hostsPerOwner,
  ) {
    identifier(poolId);
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 64)
      throw new Error("Invalid owner capacity");
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
  async enqueue(
    owner: string,
    sandboxId: string,
    id: string,
    input: Json,
  ): Promise<Ticket> {
    identifier(owner);
    identifier(sandboxId);
    identifier(id);
    const encoded = canonical(input);
    if (encoded.length > 65536) throw new Error("Placement input bound");
    return this.state.transaction((tx) => {
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
      return ticket;
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
          (slot) =>
            slot.phase === "idle" &&
            slot.expiresAt > this.now() + DEFAULTS.hostDrainMs,
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
        expiresAt: this.now() + DEFAULTS.hostLifetimeMs,
        idleSince: null,
      };
      tx.put(this.slotKey(slot.id), slot);
      return slot;
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
        .some((row) => row.value.phase === "queued");
      if (!demand) {
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
      tx.put(key, machine);
      tx.put(this.slotKey(id), next);
      return next;
    });
  }
  async assign(
    owner: string,
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
          slot.expiresAt > this.now() + DEFAULTS.hostDrainMs,
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
      return { ticket, slot: next, lease };
    });
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
    await this.state.transaction((tx) => {
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
      tx.put(this.slotKey(slot.id), {
        ...slot,
        phase: "idle",
        lease: null,
        idleSince: this.now(),
      });
    });
  }
  async retireIdle(id: string): Promise<PoolSlot> {
    return this.state.transaction((tx) => {
      const slot = tx.get<PoolSlot>(this.slotKey(id));
      if (!slot || slot.phase !== "idle" || slot.lease || !slot.machineId)
        throw new Error("Host not idle");
      if (
        slot.expiresAt > this.now() + DEFAULTS.hostDrainMs &&
        (slot.idleSince === null ||
          slot.idleSince + DEFAULTS.idleMs > this.now())
      )
        throw new Error("Idle retention not elapsed");
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
