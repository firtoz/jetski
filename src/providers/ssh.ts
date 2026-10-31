import {
  type HostProvider,
  identifier,
  type StateStore,
} from "../core/contracts.js";
import {
  HOST_PROTOCOL_VERSION,
  type HostTransport,
} from "../core/transport.js";

type Allocation = { owner: string; operationId: string; allocated: boolean };
/** Adopts explicit operator inventory. Retiring never powers off or deletes a
 * machine, and its persistent owner binding is never cleared automatically. */
export class SshHostProvider implements HostProvider {
  private readonly hosts: string[];
  constructor(
    hosts: string[],
    private readonly state: StateStore,
    private readonly transport: HostTransport,
  ) {
    this.hosts = hosts.map(identifier);
    if (new Set(this.hosts).size !== this.hosts.length)
      throw new Error("Duplicate adopted host");
  }
  capabilities() {
    return {
      kind: "machine-host",
      architecture: "x86_64",
      rootlessPodman: true,
    } as const;
  }
  async allocate(input: {
    owner: string;
    operationId: string;
    expiresAt: number;
  }): Promise<{ id: string; allocationId: string }> {
    identifier(input.owner);
    identifier(input.operationId);
    return this.state.transaction((tx) => {
      const operationKey = `ssh-allocation/${input.owner}/${input.operationId}`;
      const prior = tx.get<string>(operationKey);
      if (prior) return { id: prior, allocationId: input.operationId };
      const id = this.hosts.find((id) => {
        const allocation = tx.get<Allocation>(`ssh-host/${id}`);
        return (
          !allocation ||
          (allocation.owner === input.owner && !allocation.allocated)
        );
      });
      if (!id)
        throw new Error("No eligible adopted host; request must remain queued");
      tx.put(`ssh-host/${id}`, {
        owner: input.owner,
        operationId: input.operationId,
        allocated: true,
      });
      tx.put(operationKey, id);
      return { id, allocationId: input.operationId };
    });
  }
  async inspect(id: string): Promise<{ state: "ready" | "unknown" }> {
    if (!this.hosts.includes(id)) throw new Error("Host not configured");
    try {
      const response = await this.transport.request(id, {
        version: HOST_PROTOCOL_VERSION,
        id: crypto.randomUUID(),
        action: "status",
        payload: null,
      });
      if (
        response.result &&
        typeof response.result === "object" &&
        !Array.isArray(response.result) &&
        response.result.ready === true
      )
        return { state: "ready" };
      return { state: "unknown" };
    } catch {
      return { state: "unknown" };
    }
  }
  async retire(id: string, allocationId: string): Promise<void> {
    if (!this.hosts.includes(id)) throw new Error("Host not configured");
    await this.state.transaction((tx) => {
      const key = `ssh-host/${id}`;
      const allocation = tx.get<Allocation>(key);
      if (!allocation) throw new Error("Host has no allocation");
      if (allocation.operationId !== allocationId)
        throw new Error("Stale host allocation");
      tx.put(key, { ...allocation, allocated: false });
    });
  }
}
