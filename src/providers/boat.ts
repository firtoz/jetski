import {
  canonical,
  type HostObservation,
  type HostProvider,
  identifier,
  type Json,
  type StateStore,
} from "../core/contracts.js";
import { HOST_LIFECYCLE_LIMITS } from "../core/host-lifecycle.js";
import {
  HOST_IMPORT_FILE_BYTES,
  HOST_PROTOCOL_VERSION,
  type HostTransport,
  HostTransportError,
} from "../core/transport.js";
import { sequentialCheckpointDownload } from "../transport/checkpoint-download.js";

export const BOAT_MACHINE_TYPES = ["small", "default", "large"] as const;
export type BoatMachineType = (typeof BOAT_MACHINE_TYPES)[number];
// Leave a full hour inside the documented 24-hour provider key retention window,
// independently of a longer physical lease and bounded in-flight HTTP requests.
const ALLOCATION_REPLAY_WINDOW_MS = 23 * 60 * 60_000;
export type BoatAllocation = {
  owner: string;
  operationId: string;
  expiresAt: number;
  key: string;
  body: Json;
  id: string | null;
  retired: boolean;
  retryUntil?: number;
};
type Reply = { status: number; value: Record<string, Json> };

/** Explicit credentials, HTTPS, no redirects/retries, bounded JSON and deadline. */
export class BoatApi {
  constructor(
    private readonly token: string,
    private readonly request: typeof fetch = fetch,
  ) {
    if (!token || /[\r\n]/.test(token)) throw Error("Invalid Boat credential");
    // Native fetch implementations can reject an arbitrary class receiver.
    this.request = (input, init) => request(input, init);
  }
  /** Upload data without forwarding the API bearer credential to the capability.
   * The caller must still verify exact bytes on the host before execution. */
  async uploadFile(
    host: string,
    path: string,
    data: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.uploadBoundedFile(host, path, data, 6 * 1024 * 1024, signal);
  }
  /** Bounded raw checkpoint parts use a separate limit from control envelopes. */
  async uploadCheckpointPart(host: string, path: string, data: Uint8Array) {
    if (
      !/^\/tmp\/jetski-checkpoint-imports\/[a-f0-9-]{36}\/chunk.bin$/.test(path)
    )
      throw Error("Invalid checkpoint upload path");
    return this.uploadBoundedFile(host, path, data, HOST_IMPORT_FILE_BYTES);
  }
  async uploadMemoryPart(host: string, path: string, data: Uint8Array) {
    if (
      !/^\/tmp\/jetski-memory-imports\/[a-f0-9-]{36}-g[1-9][0-9]*\/[a-f0-9-]{36}\/chunk.bin$/.test(
        path,
      )
    )
      throw Error("Invalid memory upload path");
    return this.uploadBoundedFile(host, path, data, 4 * 1024 * 1024);
  }
  private async uploadBoundedFile(
    host: string,
    path: string,
    data: Uint8Array,
    limit: number,
    signal?: AbortSignal,
  ) {
    identifier(host);
    if (
      !/^bx_[a-zA-Z0-9_-]+$/.test(host) ||
      !path.startsWith("/") ||
      path.includes("\0") ||
      path.split("/").includes("..") ||
      path.length > 4096 ||
      data.length < 1 ||
      data.length > limit
    )
      throw Error("Invalid Boat file upload");
    signal?.throwIfAborted();
    const authorized = await this.call(
      `/sandboxes/${host}/files/upload-url`,
      "POST",
      {
        path,
        ttlSeconds: 900,
      },
      {},
      { ...(signal ? { signal } : {}) },
    );
    const capability = authorized.value;
    if (
      authorized.status !== 200 ||
      capability.ok === false ||
      capability.success === false ||
      capability.method !== "PUT" ||
      typeof capability.url !== "string" ||
      typeof capability.expiresAt !== "string"
    )
      throw Error("Invalid Boat upload capability");
    const url = new URL(capability.url);
    const expiry = Date.parse(capability.expiresAt);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      !Number.isFinite(expiry) ||
      expiry <= Date.now()
    )
      throw Error("Invalid Boat upload capability");
    const signals = [AbortSignal.timeout(60_000)];
    if (signal) signals.push(signal);
    const uploaded = await this.request(url.href, {
      method: "PUT",
      redirect: "manual",
      signal: AbortSignal.any(signals),
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(data),
    });
    await uploaded.body?.cancel();
    if (!uploaded.ok) throw Error("Boat capability upload not acknowledged");
  }
  /** One short-lived authorization, then bounded binary ranges without a bearer. */
  async openDownload(
    host: string,
    path: string,
    length: number,
    options: { sequential?: boolean } = {},
  ) {
    identifier(host);
    if (
      !path.startsWith("/") ||
      path.includes("\0") ||
      path.split("/").includes("..") ||
      !Number.isSafeInteger(length) ||
      length < 1
    )
      throw Error("Invalid Boat download");
    const reply = await this.call(
      `/sandboxes/${host}/files/download-url`,
      "POST",
      { path, ttlSeconds: 900 },
    );
    const value = reply.value;
    if (
      reply.status !== 200 ||
      value.ok === false ||
      value.success === false ||
      value.method !== "GET" ||
      typeof value.url !== "string" ||
      typeof value.expiresAt !== "string"
    )
      throw Error("Invalid Boat download capability");
    const url = new URL(value.url),
      expiry = Date.parse(value.expiresAt);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      !Number.isFinite(expiry) ||
      expiry <= Date.now()
    )
      throw Error("Invalid Boat download capability");
    const download = {
      read: async (offset: number, count: number): Promise<Uint8Array> => {
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(count) ||
          count < 1 ||
          count > 8 * 1024 * 1024 ||
          offset + count > length ||
          Date.now() >= expiry
        )
          throw Error("Invalid Boat download range");
        const response = await this.request(url.href, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(60_000),
          headers: {
            Range: `bytes=${offset}-${offset + count - 1}`,
            "Accept-Encoding": "identity",
          },
        });
        try {
          if (response.status === 206) {
            if (
              response.headers.get("content-range") !==
              `bytes ${offset}-${offset + count - 1}/${length}`
            )
              throw Error("Boat download range mismatch");
          } else if (
            response.status !== 200 ||
            offset !== 0 ||
            count !== length
          )
            throw Error("Boat download range unsupported");
          const encoding = response.headers.get("content-encoding"),
            size = response.headers.get("content-length");
          if (
            (encoding && encoding !== "identity") ||
            (size !== null && size !== String(count)) ||
            !response.body
          )
            throw Error("Boat download metadata mismatch");
          const bytes = new Uint8Array(count),
            reader = response.body.getReader();
          let received = 0;
          try {
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              if (received + part.value.length > count)
                throw Error("Oversized Boat download");
              bytes.set(part.value, received);
              received += part.value.length;
            }
          } finally {
            await reader.cancel();
          }
          if (received !== count) throw Error("Short Boat download");
          return bytes;
        } finally {
          if (response.body && !response.body.locked)
            await response.body.cancel();
        }
      },
    };
    if (!options.sequential) return { ...download, close: async () => {} };
    const stream = sequentialCheckpointDownload(length, download.read, () =>
      this.request(url.href, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(300_000),
        headers: { "Accept-Encoding": "identity" },
      }),
    );
    return {
      read: (offset: number, count: number) => {
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(count) ||
          count < 1 ||
          count > 8 * 1024 * 1024 ||
          offset + count > length ||
          Date.now() >= expiry
        )
          return Promise.reject(Error("Invalid Boat download range"));
        return stream.read(offset, count);
      },
      close: () => stream.close(),
    };
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
    const limits = path === "/limits";
    if (
      !limits &&
      !/^\/sandboxes(?:\/bx_[a-zA-Z0-9_-]+(?:\/(?:commands|files(?:\/(?:upload|download)-url)?|sshkey))?)?$/.test(
        path,
      )
    )
      throw Error("Unsupported Boat route");
    if (limits && (method !== "GET" || body !== undefined))
      throw Error("Boat limits is read-only");
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    const timeoutMs = options.timeoutMs ?? 30_000;
    // An eight-MiB private export reply is JSON-escaped inside Boat's command
    // completion envelope. Other endpoints retain their existing eight-MiB cap.
    const responseLimit = /^\/sandboxes\/bx_[a-zA-Z0-9_-]+\/commands$/.test(
      path,
    )
      ? 17 * 1024 * 1024
      : 8 * 1024 * 1024;
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > responseLimit ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 665_000
    )
      throw Error("Invalid Boat HTTP bounds");
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const response = await this.request(`https://boat.dev/api/v1${path}`, {
      method,
      redirect: "manual",
      signal: AbortSignal.any(signals),
      headers: {
        ...headers,
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw Error("Boat redirect prohibited");
    }
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
    private readonly bootstrap?: { ensure(host: string): Promise<void> },
  ) {
    if (!BOAT_MACHINE_TYPES.includes(machine))
      throw Error("Unsupported Boat machine type");
  }
  capabilities() {
    return {
      kind: "machine-host",
      architecture: "x86_64",
      rootlessPodman: true,
      maxLifetimeMs: HOST_LIFECYCLE_LIMITS.maxLifetimeMs,
      features: {
        evidence: "adapter-declaration",
        runtimes: ["podman", "gvisor"],
        networkModes: ["none", "egress", "public-egress"],
        storageModes: ["default", "fuse-overlayfs"],
        nativeIdleModes: [],
        hostStreams: true,
        portableMemoryRuntimes: ["gvisor"],
      },
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
        ttlSeconds > HOST_LIFECYCLE_LIMITS.maxLifetimeMs / 1000
      )
        throw Error("Boat allocation lifetime exceeds the supported bound");
      const row: BoatAllocation = {
        ...input,
        key: crypto.randomUUID(),
        id: null,
        retired: false,
        retryUntil: Math.min(
          input.expiresAt,
          this.now() + ALLOCATION_REPLAY_WINDOW_MS,
        ),
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
    if (
      this.now() >=
      Math.min(
        allocation.expiresAt,
        allocation.retryUntil ?? allocation.expiresAt,
      )
    )
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
  async inspect(id: string): Promise<HostObservation> {
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
      await this.bootstrap?.ensure(id);
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
    } catch (error) {
      return {
        state: "unknown",
        ...(error instanceof HostTransportError && error.details
          ? { diagnostic: error.details }
          : {}),
      };
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
