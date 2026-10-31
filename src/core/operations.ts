import {
  canonical,
  type Fence,
  identifier,
  type Json,
  type Operation,
  type Scope,
  type StateStore,
  scopeKey,
  type Transaction,
} from "./contracts.js";

/** Admission and dispatch are deliberately separate. A durable running receipt
 * must exist before effects. Recovery observes the host receipt; it never blindly
 * dispatches again. Even an expired controller lease is not evidence of failure. */
export class OperationJournal {
  constructor(
    private readonly state: StateStore,
    private readonly now = Date.now,
  ) {}
  private key(scope: Scope, id: string) {
    return `operation/${scopeKey(scope)}/${identifier(id)}`;
  }
  private fenceKey(scope: Scope) {
    return `generation/${scopeKey(scope)}`;
  }
  private check(tx: Transaction, fence: Fence) {
    const current = tx.get<number>(this.fenceKey(fence));
    if (!Number.isSafeInteger(fence.generation) || fence.generation !== current)
      throw new Error("Stale generation");
  }
  async generation(scope: Scope): Promise<Fence> {
    return this.state.transaction((tx) => {
      const key = this.fenceKey(scope);
      const generation = tx.get<number>(key) ?? 1;
      tx.put(key, generation);
      return { ...scope, generation };
    });
  }
  /** Caller must fence the host too before allowing replacement execution. */
  async advance(fence: Fence): Promise<Fence> {
    return this.state.transaction((tx) => {
      this.check(tx, fence);
      if (!Number.isSafeInteger(fence.generation + 1))
        throw new Error("Generation exhausted");
      tx.put(this.fenceKey(fence), fence.generation + 1);
      return { ...fence, generation: fence.generation + 1 };
    });
  }
  async admit(
    fence: Fence,
    id: string,
    kind: string,
    input: Json,
  ): Promise<Operation> {
    identifier(kind);
    const request = canonical(input);
    if (request.length > 65536) throw new Error("Operation input too large");
    return this.state.transaction((tx) => {
      this.check(tx, fence);
      const key = this.key(fence, id);
      const previous = tx.get<Operation>(key);
      if (previous) {
        if (previous.kind !== kind || canonical(previous.input) !== request)
          throw new Error("Operation identity conflict");
        return previous;
      }
      const at = this.now();
      const op: Operation = {
        ...fence,
        id,
        kind,
        input: JSON.parse(request),
        phase: "queued",
        createdAt: at,
        updatedAt: at,
        result: null,
        error: null,
      };
      tx.put(key, op);
      return op;
    });
  }
  async get(scope: Scope, id: string): Promise<Operation | undefined> {
    return this.state.transaction((tx) =>
      tx.get<Operation>(this.key(scope, id)),
    );
  }
  async claim(fence: Fence, id: string): Promise<boolean> {
    return this.state.transaction((tx) => {
      this.check(tx, fence);
      const key = this.key(fence, id);
      const op = tx.get<Operation>(key);
      if (!op) throw new Error("Unknown operation");
      if (op.generation !== fence.generation)
        throw new Error("Operation generation mismatch");
      if (op.phase !== "queued") return false;
      tx.put(key, { ...op, phase: "running", updatedAt: this.now() });
      return true;
    });
  }
  async finish(
    fence: Fence,
    id: string,
    outcome: {
      phase: "succeeded" | "failed" | "uncertain";
      result: Json;
      error: string | null;
    },
  ): Promise<Operation> {
    return this.state.transaction((tx) => {
      this.check(tx, fence);
      const key = this.key(fence, id);
      const op = tx.get<Operation>(key);
      if (!op || op.generation !== fence.generation)
        throw new Error("Operation generation mismatch");
      if (op.phase === "succeeded" || op.phase === "failed") {
        if (
          canonical({ phase: op.phase, result: op.result, error: op.error }) !==
          canonical(outcome)
        )
          throw new Error("Terminal outcome conflict");
        return op;
      }
      if (op.phase !== "running" && op.phase !== "uncertain")
        throw new Error("Operation not dispatched");
      const next = { ...op, ...outcome, updatedAt: this.now() };
      tx.put(key, next);
      return next;
    });
  }
  async pending(scope: Scope): Promise<Operation[]> {
    return this.state.transaction((tx) =>
      tx
        .scan<Operation>(`operation/${scopeKey(scope)}/`)
        .map((row) => row.value)
        .filter(
          (op) =>
            op.phase === "queued" ||
            op.phase === "running" ||
            op.phase === "uncertain",
        ),
    );
  }
}
