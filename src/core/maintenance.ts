import {
  DEFAULTS,
  type Fence,
  type Json,
  type Scope,
  type StateStore,
  scopeKey,
  type Transaction,
} from "./contracts.js";

const RETRY_MS = 5 * 60_000;
type Maintenance = {
  dueAt: number;
  attempt: { id: string; generation: number } | null;
  last: { id: string; deleted: number; at: number } | null;
};

/** Durable cadence; the collector remains authoritative for grace and fencing.
 * A failed attempt retains its identity, including across controller restarts. */
export class CheckpointMaintenance {
  constructor(
    private state: StateStore,
    private eligible: (tx: Transaction, scope: Scope) => Fence | undefined,
    private collect: (fence: Fence, id: string) => Promise<{ deleted: number }>,
    private now: () => number = Date.now,
  ) {}
  async run(scope: Scope): Promise<void> {
    if (!Number.isSafeInteger(this.now()) || this.now() < 0)
      throw Error("Invalid maintenance clock");
    const key = `checkpoint-maintenance/${scopeKey(scope)}`;
    const selected = await this.state.transaction((tx) => {
      const fence = this.eligible(tx, scope);
      if (!fence) return;
      const previous = tx.get<Maintenance>(key);
      if (
        previous &&
        (Object.keys(previous).sort().join(",") !== "attempt,dueAt,last" ||
          !Number.isSafeInteger(previous.dueAt) ||
          previous.dueAt < 0 ||
          (previous.attempt !== null &&
            (!previous.attempt ||
              !/^[a-zA-Z0-9_-]{1,128}$/.test(previous.attempt.id) ||
              !Number.isSafeInteger(previous.attempt.generation) ||
              previous.attempt.generation < 1)) ||
          (previous.last !== null &&
            (!previous.last ||
              !Number.isSafeInteger(previous.last.at) ||
              previous.last.at < 0 ||
              !Number.isSafeInteger(previous.last.deleted) ||
              previous.last.deleted < 0)))
      )
        throw Error("Ambiguous maintenance journal");
      const record = previous ?? {
        dueAt: this.now() + DEFAULTS.gcGraceMs,
        attempt: null,
        last: null,
      };
      if (!previous) tx.put(key, record);
      if (record.dueAt > this.now()) return;
      if (record.attempt && record.attempt.generation !== fence.generation)
        throw Error(
          "Maintenance generation changed; reconcile original collector",
        );
      const attempt = record.attempt ?? {
        id: crypto.randomUUID(),
        generation: fence.generation,
      };
      tx.put(key, { ...record, attempt, dueAt: this.now() + RETRY_MS });
      return { fence, attempt };
    });
    if (!selected) return;
    const result = await this.collect(selected.fence, selected.attempt.id);
    if (!Number.isSafeInteger(result.deleted) || result.deleted < 0)
      throw Error("Invalid collection outcome");
    await this.state.transaction((tx) => {
      const record = tx.get<Maintenance>(key);
      if (
        record?.attempt?.id !== selected.attempt.id ||
        record.attempt.generation !== selected.fence.generation
      )
        throw Error("Maintenance completion fenced");
      tx.put(key, {
        dueAt: this.now() + DEFAULTS.gcGraceMs,
        attempt: null,
        last: {
          id: selected.attempt.id,
          deleted: result.deleted,
          at: this.now(),
        },
      });
    });
  }
  async status(scope: Scope): Promise<Json | undefined> {
    return this.state.transaction((tx) =>
      tx.get(`checkpoint-maintenance/${scopeKey(scope)}`),
    );
  }
}
