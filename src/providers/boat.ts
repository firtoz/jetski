import {
  canonical,
  DEFAULTS,
  type HostProvider,
  identifier,
  type Json,
  type StateStore,
} from "../core/contracts.js";
import {
  HOST_PROTOCOL_VERSION,
  type HostTransport,
} from "../core/transport.js";

export const BOAT_MACHINE_TYPES = ["small", "default", "large"] as const;
export type BoatMachineType = (typeof BOAT_MACHINE_TYPES)[number];
export type BoatAllocation = {
  owner: string;
  operationId: string;
  expiresAt: number;
  key: string;
  body: Json;
  id: string | null;
  retired: boolean;
};
type Reply = { status: number; value: Record<string, Json> };

/** Explicit credentials, HTTPS, no redirects/retries, bounded JSON and deadline. */
export class BoatApi {
  constructor(
    private readonly token: string,
    private readonly request: typeof fetch = fetch,
  ) {
    if (!token || /[\r\n]/.test(token)) throw Error("Invalid Boat credential");
  }
  async call(
    path: string,
    method = "GET",
    body?: Json,
    headers: Record<string, string> = {},
    options: {
      maxBytes?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<Reply> {
    if (
      !/^\/sandboxes(?:\/bx_[a-zA-Z0-9_-]+(?:\/(?:commands|files))?)?$/.test(
        path,
      )
    )
      throw Error("Unsupported Boat route");
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 8 * 1024 * 1024 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 665_000
    )
      throw Error("Invalid Boat HTTP bounds");
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const response = await this.request(`https://boat.dev/api/v1${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.any(signals),
      headers: {
        ...headers,
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.body) throw Error("Missing Boat response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > maxBytes) throw Error("Boat response bound exceeded");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const full = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      full.set(chunk, offset);
      offset += chunk.length;
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(full));
    } catch {
      throw Error("Invalid Boat JSON response");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("Invalid Boat response");
    return { status: response.status, value: value as Record<string, Json> };
  }
}
function box(reply: Reply): { id: string; state: string } {
  const value = reply.value.sandbox;
  if (
    reply.status < 200 ||
    reply.status >= 300 ||
    reply.value.ok === false ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.id !== "string" ||
    !/^bx_[a-zA-Z0-9_-]+$/.test(value.id) ||
    typeof value.state !== "string"
  )
    throw Error(`Boat resource response unavailable (${reply.status})`);
  return { id: value.id, state: value.state };
}

/** Owns only machines returned by its durable allocation journal. Provider ready
 * is insufficient: a separately bootstrapped host-control agent must attest ready. */
export class BoatHostProvider implements HostProvider {
  constructor(
    private readonly state: StateStore,
    private readonly api: BoatApi,
    private readonly transport: HostTransport,
    private readonly machine: BoatMachineType = "small",
    private readonly now = Date.now,
  ) {
    if (!BOAT_MACHINE_TYPES.includes(machine))
      throw Error("Unsupported Boat machine type");
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
  }) {
    identifier(input.owner);
    identifier(input.operationId);
    const key = `boat-allocation/${input.owner}/${input.operationId}`;
    const allocation = await this.state.transaction((tx) => {
      const prior = tx.get<BoatAllocation>(key);
      if (prior) {
        if (prior.expiresAt !== input.expiresAt)
          throw Error("Boat allocation identity conflict");
        return prior;
      }
      const ttlSeconds = Math.floor((input.expiresAt - this.now()) / 1000);
      if (
        !Number.isSafeInteger(input.expiresAt) ||
        ttlSeconds < 1 ||
        ttlSeconds > DEFAULTS.hostLifetimeMs / 1000
      )
        throw Error("Boat allocation lifetime must be within one hour");
      const row: BoatAllocation = {
        ...input,
        key: crypto.randomUUID(),
        id: null,
        retired: false,
        body: {
          type: this.machine,
          ttlSeconds,
          noEnv: true,
          env: {},
          snapshots: false,
          monitoring: false,
        },
      };
      tx.put(key, row);
      return row;
    });
    if (allocation.id)
      return { id: allocation.id, allocationId: input.operationId };
    // Never risk allocation after provider idempotency expires or the requested
    // lifetime ends. Reconciliation must preserve the original uncertain record.
    if (this.now() >= allocation.expiresAt)
      throw Error("Expired uncertain Boat allocation requires reconciliation");
    const resource = box(
      await this.api.call("/sandboxes", "POST", allocation.body, {
        "Idempotency-Key": allocation.key,
      }),
    );
    await this.state.transaction((tx) => {
      const current = tx.get<BoatAllocation>(key);
      if (
        !current ||
        current.key !== allocation.key ||
        canonical(current.body) !== canonical(allocation.body) ||
        (current.id !== null && current.id !== resource.id)
      )
        throw Error("Boat allocation receipt conflict");
      const owner = tx.get<string>(`boat-host/${resource.id}`);
      if (owner && owner !== key) throw Error("Boat host ownership conflict");
      tx.put(`boat-host/${resource.id}`, key);
      tx.put(key, { ...current, id: resource.id });
    });
    return { id: resource.id, allocationId: input.operationId };
  }
  private async owned(
    id: string,
  ): Promise<{ key: string; allocation: BoatAllocation }> {
    identifier(id);
    return this.state.transaction((tx) => {
      const key = tx.get<string>(`boat-host/${id}`);
      const allocation = key ? tx.get<BoatAllocation>(key) : undefined;
      if (!key || !allocation || allocation.id !== id)
        throw Error("Boat host not owned by this controller");
      return { key, allocation };
    });
  }
  async inspect(
    id: string,
  ): Promise<{ state: "ready" | "starting" | "absent" | "unknown" }> {
    const { allocation } = await this.owned(id);
    if (allocation.retired) return { state: "absent" };
    try {
      const reply = await this.api.call(`/sandboxes/${id}`);
      if (reply.status === 404) return { state: "absent" };
      const resource = box(reply);
      if (resource.id !== id) return { state: "unknown" };
      if (["provisioning", "provisioned", "cloning"].includes(resource.state))
        return { state: "starting" };
      if (!["ready", "idle", "running"].includes(resource.state))
        return { state: "unknown" };
      const response = await this.transport.request(id, {
        version: HOST_PROTOCOL_VERSION,
        id: crypto.randomUUID(),
        action: "status",
        payload: null,
      });
      const result = response.result;
      if (
        result &&
        typeof result === "object" &&
        !Array.isArray(result) &&
        result.ready === true &&
        result.machineId === id
      )
        return { state: "ready" };
      return { state: "unknown" };
    } catch {
      return { state: "unknown" };
    }
  }
  async retire(id: string, allocationId: string): Promise<void> {
    const { key, allocation } = await this.owned(id);
    if (allocation.operationId !== allocationId)
      throw Error("Stale Boat allocation");
    if (allocation.retired) return;
    const response = await this.api.call(
      `/sandboxes/${id}`,
      "DELETE",
      undefined,
      { "X-Ascii-Confirm-Delete": id },
    );
    if (
      response.status !== 404 &&
      (response.status < 200 ||
        response.status >= 300 ||
        response.value.ok === false)
    )
      throw Error(`Boat deletion unavailable (${response.status})`);
    // Accepted deletion can be replayed as 202; absence is the terminal evidence.
    const observed = await this.api.call(`/sandboxes/${id}`);
    if (observed.status !== 404)
      throw Error("Boat deletion still pending or uncertain");
    await this.state.transaction((tx) => {
      const current = tx.get<BoatAllocation>(key);
      if (!current || current.id !== id || current.operationId !== allocationId)
        throw Error("Boat retirement fenced");
      tx.put(key, { ...current, retired: true });
    });
  }
}
