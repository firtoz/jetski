import {
  canonical,
  identifier,
  type Operation,
  type Scope,
  type StateStore,
  scopeKey,
  type Transaction,
} from "./contracts.js";
import type { OperationJournal } from "./operations.js";
import type { HostLease } from "./pool.js";

export const MAX_ACTIVE_PORTS = 64;
export function tcpPort(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65535
  )
    throw Error("Invalid TCP port");
  return value;
}
export type PortContext = {
  generation: number;
  lease: HostLease | null;
  image: string;
  running: boolean;
};
type Exposure = {
  id: string;
  port: number;
  generation: number;
  lease: HostLease;
  image: string;
  revoked: boolean;
};
export type PortStatus = {
  id: string;
  port: number;
  generation: number;
  revoked: boolean;
  available: boolean;
};
/** Durable permission to reach a workload loopback port. Never an arbitrary host address. */
export class PortRegistry {
  constructor(
    private readonly state: StateStore,
    private readonly operations: OperationJournal,
    private readonly context: (tx: Transaction, scope: Scope) => PortContext,
  ) {}
  private key(scope: Scope, id: string) {
    return `port/${scopeKey(scope)}/${identifier(id)}`;
  }
  private available(tx: Transaction, scope: Scope, record: Exposure): boolean {
    const current = this.context(tx, scope);
    return (
      !record.revoked &&
      current.running &&
      current.generation === record.generation &&
      tx.get<number>(`generation/${scopeKey(scope)}`) === record.generation &&
      current.image === record.image &&
      canonical(current.lease) === canonical(record.lease)
    );
  }
  private replay(
    tx: Transaction,
    scope: Scope,
    id: string,
    kind: string,
    input: { port: number } | { exposureId: string },
  ): Operation | undefined {
    const prior = this.operations.getIn(tx, scope, id);
    if (
      prior &&
      (prior.kind !== kind ||
        canonical(prior.input) !== canonical(input) ||
        prior.phase !== "succeeded")
    )
      throw Error("Port operation identity conflict");
    return prior;
  }
  async expose(scope: Scope, id: string, port: number): Promise<Operation> {
    tcpPort(port);
    return this.state.transaction((tx) => {
      const replay = this.replay(tx, scope, id, "port-expose", { port });
      if (replay) return replay;
      const current = this.context(tx, scope);
      if (!current.running || !current.lease)
        throw Error("Sandbox not running");
      const prefix = `port/${scopeKey(scope)}/`;
      if (
        tx
          .scan<Exposure>(prefix)
          .filter(({ value }) => this.available(tx, scope, value)).length >=
        MAX_ACTIVE_PORTS
      )
        throw Error("Active port limit reached");
      const fence = { ...scope, generation: current.generation };
      this.operations.admitIn(tx, fence, id, "port-expose", { port });
      this.operations.claimIn(tx, fence, id);
      tx.put(this.key(scope, id), {
        id,
        port,
        generation: current.generation,
        lease: current.lease,
        image: current.image,
        revoked: false,
      });
      return this.operations.finishIn(tx, fence, id, {
        phase: "succeeded",
        result: { exposureId: id, port, generation: current.generation },
        error: null,
      });
    });
  }
  async revoke(
    scope: Scope,
    exposureId: string,
    operationId: string,
  ): Promise<Operation> {
    identifier(exposureId);
    return this.state.transaction((tx) => {
      const replay = this.replay(tx, scope, operationId, "port-revoke", {
        exposureId,
      });
      if (replay) return replay;
      const record = tx.get<Exposure>(this.key(scope, exposureId));
      if (!record) throw Error("Port exposure unavailable");
      const current = this.context(tx, scope);
      const fence = { ...scope, generation: current.generation };
      this.operations.admitIn(tx, fence, operationId, "port-revoke", {
        exposureId,
      });
      this.operations.claimIn(tx, fence, operationId);
      tx.put(this.key(scope, exposureId), { ...record, revoked: true });
      return this.operations.finishIn(tx, fence, operationId, {
        phase: "succeeded",
        result: { exposureId, revoked: true },
        error: null,
      });
    });
  }
  async status(scope: Scope, id: string): Promise<PortStatus> {
    return this.state.transaction((tx) => {
      const record = tx.get<Exposure>(this.key(scope, id));
      if (!record) throw Error("Port exposure unavailable");
      return {
        id: record.id,
        port: record.port,
        generation: record.generation,
        revoked: record.revoked,
        available: this.available(tx, scope, record),
      };
    });
  }
  authorizeIn(
    tx: Transaction,
    scope: Scope,
    id: string,
  ): {
    lease: HostLease;
    image: string;
    port: number;
    generation: number;
  } {
    const record = tx.get<Exposure>(this.key(scope, id));
    if (!record || !this.available(tx, scope, record))
      throw Error("Port exposure unavailable");
    return {
      lease: record.lease,
      image: record.image,
      port: record.port,
      generation: record.generation,
    };
  }
  async authorize(
    scope: Scope,
    id: string,
  ): Promise<{
    lease: HostLease;
    image: string;
    port: number;
  }> {
    return this.state.transaction((tx) => {
      const { lease, image, port } = this.authorizeIn(tx, scope, id);
      return { lease, image, port };
    });
  }
}
