import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type CommandResult,
  type CreateOptions,
  type ExecOptions,
  type FromCheckpointOptions,
  type OperationOptions,
  type SandboxApi,
  SandboxSession,
  type SessionOptions,
  sandboxSession,
  sessionDeadline,
} from "./client/sandbox.js";
import {
  type CheckpointStore,
  canonical,
  type HostProvider,
  identifier,
  type Json,
  type StateStore,
} from "./core/contracts.js";
import type { HostLifecycle, IdlePriceSource } from "./core/host-lifecycle.js";
import type { HostStreamTransport } from "./core/host-stream.js";
import { type ManagerOptions, SandboxManager } from "./core/manager.js";
import { identityMemoryCodec } from "./core/memory-chunk-codec.js";
import type { HostTransport } from "./core/transport.js";
import { managerApi } from "./node/manager-api.js";
import { acquireControllerLock } from "./server/controller-lock.js";
import type { HostConfig } from "./server/hosts.js";
import { SqliteState } from "./state/sqlite.js";
import { gzipMemoryCodec } from "./storage/memory-codecs.js";

export type NodeHostAdapters = {
  provider: HostProvider;
  transport: HostTransport;
  streamTransport?: HostStreamTransport;
  idlePriceSource?: IdlePriceSource;
  close?: () => void | Promise<void>;
};
export type NodeHostFactoryContext = {
  state: StateStore;
  poolId: string;
  approvedImages: readonly string[];
};
export type NodeProvider =
  | {
      kind: "factory";
      id: string;
      create(
        context: NodeHostFactoryContext,
      ): NodeHostAdapters | Promise<NodeHostAdapters>;
    }
  | (Omit<Extract<HostConfig, { kind: "boat" }>, "tokenEnv"> & {
      token: string;
    })
  | Extract<HostConfig, { kind: "ssh" }>
  | {
      kind: "custom";
      id: string;
      provider: HostProvider;
      transport: HostTransport;
      streamTransport?: HostStreamTransport;
      idlePriceSource?: IdlePriceSource;
      close?: () => void | Promise<void>;
    };
export type NodeStorage =
  | { kind: "local" }
  | {
      kind: "s3";
      endpoint: string;
      bucket: string;
      prefix: string;
      region?: string;
      credentials: {
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken?: string;
      };
    }
  | {
      kind: "custom";
      id: string;
      store: CheckpointStore;
      close?: () => void | Promise<void>;
    };
export type NodeOptions = SessionOptions & {
  provider: NodeProvider;
  dataDirectory: string;
  storage?: NodeStorage;
  image?: string;
  approvedImages?: string[];
  owner?: string;
  /** Stable host bootstrap identity; existing state must retain the same pool. */
  poolId?: string;
  hostLifecycle?: HostLifecycle;
  hostsPerOwner?: number;
  workloadResources?: ManagerOptions["workloadResources"];
  events?: ManagerOptions["events"];
  timings?: ManagerOptions["timings"];
  state?: { id: string; store: StateStore; close?: () => void | Promise<void> };
  /** An injected scheduler must independently call tick and await it when stopped. */
  scheduler?: (tick: () => Promise<void>) => () => Promise<void>;
  onError?: (error: unknown) => void;
};
type Identity = {
  version: 1;
  owner: string;
  poolId: string;
  configuration: string;
};

function intervalScheduler(tick: () => Promise<void>) {
  let running: Promise<void> | undefined,
    stopped = false;
  const run = () => {
    if (stopped || running) return;
    running = tick().finally(() => {
      running = undefined;
    });
  };
  const timer = setInterval(run, 1000);
  run();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
function configuration(
  options: NodeOptions,
  storage: NodeStorage,
  images: string[],
) {
  let provider: Json;
  switch (options.provider.kind) {
    case "boat": {
      const { token: _token, ...policy } = options.provider;
      provider = JSON.parse(JSON.stringify(policy)) as Json;
      break;
    }
    case "ssh":
      provider = {
        kind: "ssh",
        hosts: options.provider.hosts.map(
          ({ id, hostname, port, user, backend }) => ({
            id,
            hostname,
            port,
            user,
            ...(backend ? { backend } : {}),
          }),
        ),
      } as Json;
      break;
    case "factory":
    case "custom":
      identifier(options.provider.id);
      provider = { kind: options.provider.kind, id: options.provider.id };
      break;
  }
  let objects: Json;
  switch (storage.kind) {
    case "local":
      objects = { kind: "local" };
      break;
    case "s3":
      objects = {
        kind: "s3",
        endpoint: storage.endpoint,
        bucket: storage.bucket,
        prefix: storage.prefix,
        region: storage.region ?? "auto",
      };
      break;
    case "custom":
      identifier(storage.id);
      objects = { kind: "custom", id: storage.id };
      break;
  }
  if (options.state) identifier(options.state.id);
  return canonical({
    provider,
    storage: objects,
    state: options.state?.id ?? "sqlite",
    images: [...images].sort(),
  });
}
async function objects(directory: string, storage: NodeStorage) {
  if (storage.kind === "custom")
    return { store: storage.store, close: storage.close ?? (() => {}) };
  const { standaloneStorage } = await import("./server/storage.js");
  if (storage.kind === "local")
    return standaloneStorage(directory, { kind: "local" });
  return standaloneStorage(
    directory,
    {
      kind: "s3",
      endpoint: storage.endpoint,
      bucket: storage.bucket,
      prefix: storage.prefix,
      region: storage.region ?? "auto",
      accessKeyEnv: "JETSKI_NODE_ACCESS",
      secretKeyEnv: "JETSKI_NODE_SECRET",
      ...(storage.credentials.sessionToken
        ? { sessionTokenEnv: "JETSKI_NODE_SESSION" }
        : {}),
    },
    {
      JETSKI_NODE_ACCESS: storage.credentials.accessKeyId,
      JETSKI_NODE_SECRET: storage.credentials.secretAccessKey,
      ...(storage.credentials.sessionToken
        ? { JETSKI_NODE_SESSION: storage.credentials.sessionToken }
        : {}),
    },
  );
}

/** Embedded single-owner Node controller. Opening starts no listener and fresh
 * state has no demand allocations. Existing admitted work reconciles on restart. */
export class NodeJetski {
  private closing = false;
  private closed = false;
  private closingPromise: Promise<void> | undefined;
  private stopScheduler: (() => Promise<void>) | undefined;
  private readonly active = new Set<Promise<unknown>>();
  private readonly ticks = new Set<Promise<unknown>>();
  private lastFailure: unknown;
  readonly api: SandboxApi;
  private readonly sessions: SessionOptions;
  constructor(
    readonly owner: string,
    readonly manager: SandboxManager,
    private readonly state: StateStore,
    private readonly options: NodeOptions,
    private readonly cleanup: Array<() => void | Promise<void>>,
  ) {
    this.sessions = {
      ...(options.waitTimeoutMs === undefined
        ? {}
        : { waitTimeoutMs: options.waitTimeoutMs }),
      onOperation: async (operation) => {
        await state.transaction((tx) => {
          const key = `node/intent/${operation.sandboxId}/${operation.operationId}`;
          const value = { ...operation } as Json,
            previous = tx.get(key);
          if (previous && canonical(previous) !== canonical(value))
            throw Error("Local operation identity conflict");
          tx.put(key, value);
        });
        await options.onOperation?.(operation);
      },
    };
    this.api = managerApi(manager, owner, (body, signal) =>
      this.invoke(body, signal),
    );
  }
  private invoke<T>(body: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closing || this.closed)
      return Promise.reject(Error("Controller is closed or closing"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const result = Promise.resolve().then(() => {
      signal?.throwIfAborted();
      return body();
    });
    this.active.add(result);
    result.then(
      () => this.active.delete(result),
      () => this.active.delete(result),
    );
    if (!signal) return result;
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      result
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
  }
  private client(signal: AbortSignal) {
    return managerApi(
      this.manager,
      this.owner,
      (body, abort) => this.invoke(body, abort),
      signal,
    );
  }
  start() {
    if (this.stopScheduler || this.closing || this.closed)
      throw Error("Controller scheduler already started or closed");
    const tick = async () => {
      if (this.closing || this.closed) return;
      const job = (async () => {
        try {
          await this.manager.reconcile(this.owner);
          await this.manager.maintain(this.owner);
          this.lastFailure = undefined;
        } catch (error) {
          this.lastFailure = error;
          try {
            this.options.onError?.(error);
          } catch {}
        }
      })();
      this.ticks.add(job);
      try {
        await job;
      } finally {
        this.ticks.delete(job);
      }
    };
    this.stopScheduler = (this.options.scheduler ?? intervalScheduler)(tick);
  }
  health() {
    return {
      closed: this.closed,
      closing: this.closing,
      reconciliationFailed: this.lastFailure !== undefined,
    };
  }
  async create(
    options: Omit<CreateOptions, "image"> & { image?: string } = {},
  ) {
    const image = options.image ?? this.options.image;
    if (!image) throw Error("An approved image is required");
    return sandboxSession(this.sessions, (signal) => this.client(signal), {
      ...options,
      image,
    });
  }
  fromCheckpoint(options: FromCheckpointOptions) {
    return SandboxSession.fromCheckpoint(
      this.sessions,
      (signal) => this.client(signal),
      options,
    );
  }
  async get(id: string, options: OperationOptions = {}) {
    const info = await this.client(
      sessionDeadline(options, this.sessions),
    ).getSandbox(id);
    return SandboxSession.attach(
      this.sessions,
      (signal) => this.client(signal),
      info,
    );
  }
  list(options: OperationOptions = {}) {
    return this.client(sessionDeadline(options, this.sessions)).listSandboxes();
  }
  /** Quiesce/save known owned workloads, retire released idle hosts, then close.
   * Unsettled/uncertain sources remain intact and produce an error with IDs. */
  close(): Promise<void> {
    this.closingPromise ??= this.finish();
    return this.closingPromise;
  }
  private async finish() {
    this.closing = true;
    const failures: unknown[] = [];
    try {
      await this.stopScheduler?.();
      await Promise.allSettled([...this.ticks]);
      await Promise.allSettled([...this.active]);
      const existing = await this.manager.list(this.owner);
      const unsettled = existing.filter(
        (s) =>
          !["running", "stopped", "deleted"].includes(s.phase) ||
          s.pendingResume,
      );
      if (unsettled.length)
        throw Error(
          `Unsettled sandboxes retained in ${this.options.dataDirectory}: ${unsettled.map((s) => s.id).join(", ")}`,
        );
      const signal = sessionDeadline({}, this.sessions);
      const stops: Array<{ sandbox: string; operation: string }> = [];
      for (const sandbox of existing) {
        if (!sandbox.lease) continue;
        const operation = await this.state.transaction((tx) => {
          const key = `node/close/${sandbox.id}/${sandbox.generation}`;
          let id = tx.get<string>(key);
          if (!id) {
            id = crypto.randomUUID();
            tx.put(key, id);
          }
          return id;
        });
        await this.manager.stop(
          { owner: this.owner, sandbox: sandbox.id },
          operation,
        );
        stops.push({ sandbox: sandbox.id, operation });
      }
      while (stops.length) {
        signal.throwIfAborted();
        await this.manager.reconcile(this.owner);
        for (let i = stops.length - 1; i >= 0; i--) {
          const stop = stops[i]!;
          const outcome = await this.manager.operation(
            { owner: this.owner, sandbox: stop.sandbox },
            stop.operation,
          );
          if (!outcome) throw Error("Shutdown operation unavailable");
          if (outcome.phase === "succeeded") stops.splice(i, 1);
          else if (outcome.phase !== "queued" && outcome.phase !== "running")
            throw Error(
              `Shutdown ${stop.operation} for ${stop.sandbox} is ${outcome.phase}; source retained`,
            );
        }
        if (stops.length)
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              clearTimeout(timer);
              reject(signal.reason);
            };
            const timer = setTimeout(() => {
              signal.removeEventListener("abort", abort);
              resolve();
            }, 100);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          });
      }
      const remaining = await this.manager.list(this.owner);
      if (
        remaining.some(
          (s) =>
            s.lease ||
            s.pendingResume ||
            !["stopped", "deleted"].includes(s.phase),
        )
      )
        throw Error("Sources not fully released; no forced cleanup");
      await this.manager.retireIdle(this.owner);
    } catch (error) {
      failures.push(error);
    }
    for (const close of this.cleanup) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    this.closed = true;
    if (failures.length)
      throw new AggregateError(
        failures,
        `Controller shutdown incomplete; recovery state retained in ${this.options.dataDirectory}`,
      );
  }
}

export async function openJetski(input: NodeOptions): Promise<NodeJetski> {
  const options = { ...input },
    storage = input.storage ?? { kind: "local" as const };
  if (!options.dataDirectory) throw Error("dataDirectory is required");
  if (options.poolId !== undefined) identifier(options.poolId);
  const images = [
    ...(options.approvedImages ?? (options.image ? [options.image] : [])),
  ];
  if (
    !images.length ||
    images.some(
      (image) => !/^[-a-zA-Z0-9./_:]+@sha256:[a-f0-9]{64}$/.test(image),
    )
  )
    throw Error("Approved digest-pinned images required");
  if (options.image && !images.includes(options.image))
    throw Error("Default image is not approved");
  const seal = configuration(options, storage, images),
    directory = resolve(options.dataDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await acquireControllerLock(directory);
  const cleanup: Array<() => void | Promise<void>> = [release];
  try {
    let state: StateStore;
    if (options.state) {
      state = options.state.store;
      if (options.state.close) cleanup.unshift(options.state.close);
    } else {
      const sqlite = new SqliteState(join(directory, "state.sqlite"));
      state = sqlite;
      cleanup.unshift(() => sqlite.close());
    }
    const identity = await state.transaction((tx) => {
      const prior = tx.get<Identity>("node/identity");
      if (prior) {
        if (
          prior.version !== 1 ||
          prior.configuration !== seal ||
          (options.owner && options.owner !== prior.owner) ||
          (options.poolId !== undefined && options.poolId !== prior.poolId)
        )
          throw Error(
            "Controller configuration/owner does not match this data directory",
          );
        return prior;
      }
      const owner = identifier(options.owner ?? crypto.randomUUID());
      const value: Identity = {
        version: 1,
        owner,
        poolId: identifier(options.poolId ?? crypto.randomUUID()),
        configuration: seal,
      };
      tx.put("node/identity", value);
      return value;
    });
    const selected = await objects(directory, storage);
    cleanup.unshift(selected.close);
    let hosts;
    if (
      options.provider.kind === "custom" ||
      options.provider.kind === "factory"
    ) {
      if (options.provider.kind === "factory") {
        hosts = await options.provider.create({
          state,
          poolId: identity.poolId,
          approvedImages: Object.freeze([...images]),
        });
      } else hosts = options.provider;
      if (hosts.close) cleanup.unshift(hosts.close);
    } else {
      const { standaloneHosts } = await import("./server/hosts.js");
      let config: HostConfig,
        environment: NodeJS.ProcessEnv = {};
      if (options.provider.kind === "boat") {
        const { token, ...rest } = options.provider;
        config = { ...rest, tokenEnv: "JETSKI_NODE_BOAT" };
        environment = { JETSKI_NODE_BOAT: token };
      } else config = options.provider;
      hosts = await standaloneHosts(
        state,
        config,
        identity.poolId,
        images,
        environment,
        options.hostLifecycle,
      );
    }
    const manager = new SandboxManager(
      state,
      hosts.provider,
      hosts.transport,
      selected.store,
      {
        poolId: identity.poolId,
        approvedImages: images,
        ...(options.events ? { events: options.events } : {}),
        ...(options.timings ? { timings: options.timings } : {}),
        hostsPerOwner: options.hostsPerOwner ?? 1,
        ...(hosts.streamTransport
          ? { streamTransport: hosts.streamTransport }
          : {}),
        ...(hosts.idlePriceSource
          ? { idlePriceSource: hosts.idlePriceSource }
          : {}),
        ...(options.hostLifecycle
          ? { hostLifecycle: options.hostLifecycle }
          : {}),
        ...(options.workloadResources
          ? { workloadResources: options.workloadResources }
          : {}),
        memoryCodecs: new Map([
          ["identity", identityMemoryCodec],
          ["gzip", gzipMemoryCodec],
        ]),
      },
    );
    const controller = new NodeJetski(
      identity.owner,
      manager,
      state,
      options,
      cleanup,
    );
    controller.start();
    return controller;
  } catch (error) {
    const failures = [error];
    for (const close of cleanup) {
      try {
        await close();
      } catch (cause) {
        failures.push(cause);
      }
    }
    throw new AggregateError(failures, "Controller could not open");
  }
}

/** One-shot owner-scoped compute: verified save/release/retirement on return.
 * Failed cleanup never turns an uncertain result into reported success. */
export async function runSandbox(
  options: NodeOptions & { image: string },
  argv: string[],
  execution: ExecOptions = {},
): Promise<CommandResult> {
  const controller = await openJetski(options);
  let result: CommandResult | undefined;
  const failures: unknown[] = [];
  try {
    const sandbox = await controller.create();
    result = await sandbox.exec(argv, execution);
  } catch (error) {
    failures.push(error);
  }
  try {
    await controller.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      "Sandbox run or verified cleanup failed",
    );
  return result!;
}
