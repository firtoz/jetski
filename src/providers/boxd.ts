import { createHash } from "node:crypto";
import type { HostProvider, StateStore } from "../core/contracts.js";
import { identifier } from "../core/contracts.js";

/** The SDK is supplied by the application; importing this adapter loads no SDK. */
export type BoxdMachine = {
  id: string;
  name: string;
  status: string;
  labels: Record<string, string>;
};
export type BoxdExec = AsyncIterable<Uint8Array> & {
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  write(bytes: Uint8Array | string): void;
  end(): void;
  wait(): Promise<number>;
  close(): void;
};
export interface BoxdClient {
  machines: {
    create(input: {
      name: string;
      isolated: boolean;
      deleteAfter: number;
      labels: Record<string, string>;
      config: {
        vcpu: number;
        memory: string;
        autoSuspendTimeout: number;
        ssh: boolean;
      };
    }): Promise<BoxdMachine>;
    get(id: string): Promise<BoxdMachine>;
    delete(id: string): Promise<void>;
    waitUntilReady(
      id: string,
      options?: { timeout?: number; pollInterval?: number },
    ): Promise<BoxdMachine>;
    streamExec(
      id: string,
      input: { command: string[]; cwd?: string },
    ): BoxdExec;
  };
}
export type BoxdAllocation = {
  owner: string;
  operationId: string;
  expiresAt: number;
  name: string;
  phase: "planned" | "dispatched" | "allocated" | "retired";
  id: string | null;
};
export function boxdNotFound(error: unknown) {
  return error instanceof Error && error.name === "NotFoundError";
}
export class BoxdHostProvider implements HostProvider {
  constructor(
    private state: StateStore,
    private client: BoxdClient,
    private poolId: string,
    private bootstrap: (host: string) => Promise<void>,
    private options: {
      vcpu?: number;
      memory?: string;
      now?: () => number;
    } = {},
  ) {
    identifier(poolId);
    const cpu = options.vcpu ?? 2;
    if (
      ![1, 2, 4, 8].includes(cpu) ||
      (options.memory && options.memory !== `${cpu * 4}G`)
    )
      throw Error("Unsupported boxd machine size");
  }
  capabilities() {
    return {
      kind: "machine-host",
      architecture: "x86_64",
      rootlessPodman: true,
      maxLifetimeMs: 24 * 60 * 60_000,
    } as const;
  }
  private key(operation: string) {
    return `boxd/${this.poolId}/allocation/${identifier(operation)}`;
  }
  async allocate(input: {
    owner: string;
    operationId: string;
    expiresAt: number;
  }) {
    identifier(input.owner);
    identifier(input.operationId);
    const key = this.key(input.operationId),
      now = this.options.now?.() ?? Date.now();
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now)
      throw Error("Expired boxd allocation");
    const name =
      "jetski-" +
      createHash("sha256")
        .update(this.poolId + ":" + input.operationId)
        .digest("hex")
        .slice(0, 24);
    const intent = await this.state.transaction((tx) => {
      const prior = tx.get<BoxdAllocation>(key);
      if (prior) {
        if (
          prior.owner !== input.owner ||
          prior.expiresAt !== input.expiresAt ||
          prior.name !== name ||
          prior.phase === "retired"
        )
          throw Error("Boxd allocation identity conflict");
        return { record: prior, dispatch: false };
      }
      const record: BoxdAllocation = {
        ...input,
        name,
        phase: "dispatched",
        id: null,
      };
      tx.put(key, record);
      return { record, dispatch: true };
    });
    const record = intent.record;
    if (record.id) return { id: record.id, allocationId: input.operationId };
    let machine: BoxdMachine;
    if (intent.dispatch) {
      // Immutable name/labels and durable admission precede the only create attempt.
      machine = await this.client.machines.create({
        name,
        isolated: true,
        deleteAfter: Math.max(1, Math.floor((input.expiresAt - now) / 1000)),
        labels: {
          "jetski-pool": this.poolId,
          "jetski-allocation": input.operationId,
        },
        config: {
          vcpu: this.options.vcpu ?? 2,
          memory: this.options.memory ?? `${(this.options.vcpu ?? 2) * 4}G`,
          autoSuspendTimeout: 0,
          ssh: false,
        },
      });
    } else {
      // An uncertain create is observed by its original name, never blindly replayed.
      machine = await this.client.machines.get(name);
    }
    this.validate(machine, record);
    await this.state.transaction((tx) => {
      const current = tx.get<BoxdAllocation>(key);
      if (!current || current.phase === "retired" || current.name !== name)
        throw Error("Boxd allocation fenced");
      if (current.id && current.id !== machine.id)
        throw Error("Boxd host identity conflict");
      tx.put(key, { ...current, id: machine.id, phase: "allocated" });
      tx.put(
        `boxd/${this.poolId}/host/${identifier(machine.id)}`,
        input.operationId,
      );
    });
    return { id: machine.id, allocationId: input.operationId };
  }
  private validate(machine: BoxdMachine, record: BoxdAllocation) {
    if (
      machine.name !== record.name ||
      machine.labels["jetski-pool"] !== this.poolId ||
      machine.labels["jetski-allocation"] !== record.operationId ||
      (record.id && machine.id !== record.id)
    )
      throw Error("Boxd host ownership mismatch");
  }
  async owned(id: string) {
    identifier(id);
    return this.state.transaction((tx) => {
      const operation = tx.get<string>(`boxd/${this.poolId}/host/${id}`),
        record = operation
          ? tx.get<BoxdAllocation>(this.key(operation))
          : undefined;
      if (!record || record.id !== id || record.phase === "retired")
        throw Error("Boxd host not actively owned");
      return record;
    });
  }
  async inspect(
    id: string,
  ): Promise<{ state: "ready" | "unknown" | "absent" }> {
    const record = await this.owned(id);
    let machine: BoxdMachine;
    try {
      machine = await this.client.machines.get(id);
    } catch (error) {
      if (boxdNotFound(error)) return { state: "absent" };
      throw error;
    }
    this.validate(machine, record);
    if (machine.status !== "running") return { state: "unknown" };
    await this.client.machines.waitUntilReady(id, {
      timeout: 30000,
      pollInterval: 500,
    });
    await this.bootstrap(id);
    return { state: "ready" };
  }
  async retire(id: string, allocationId: string) {
    const record = await this.state.transaction((tx) =>
      tx.get<BoxdAllocation>(this.key(allocationId)),
    );
    if (!record || record.id !== id) throw Error("Unowned boxd retirement");
    if (record.phase === "retired") return;
    try {
      const machine = await this.client.machines.get(id);
      this.validate(machine, record);
      await this.client.machines.delete(id);
    } catch (error) {
      if (!boxdNotFound(error)) throw error;
    }
    try {
      await this.client.machines.get(id);
      throw Error("Boxd deletion not yet confirmed");
    } catch (error) {
      if (!boxdNotFound(error)) throw error;
    }
    await this.state.transaction((tx) => {
      const current = tx.get<BoxdAllocation>(this.key(allocationId));
      if (!current || current.id !== id) throw Error("Boxd retirement fenced");
      tx.put(this.key(allocationId), { ...current, phase: "retired" });
    });
  }
}
