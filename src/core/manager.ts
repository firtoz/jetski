import type { CapturedArchive } from "./archive-format.js";
import { resumeCachedCheckpoint } from "./cached-resume.js";
import { CheckpointCopy } from "./checkpoint-copy.js";
import { CheckpointHistory } from "./checkpoint-history.js";
import { checkpointArchive } from "./checkpoint-layout.js";
import { CheckpointRegistry } from "./checkpoints.js";
import {
  CommandOutputStore,
  encodeBase64,
  type InlineOutput,
  OUTPUT_CHANNELS,
  OUTPUT_CHUNK,
  type OutputChannel,
  verifyOutputProof,
} from "./command-output.js";
import {
  CAPTURE_FRAME_BYTES,
  type CheckpointStore,
  canonical,
  DEFAULTS,
  type EventSink,
  type HostProvider,
  identifier,
  type Json,
  type Scope,
  type StateStore,
  scopeKey,
  type Transaction,
} from "./contracts.js";
import { FILE_CHUNK_BYTES, persistentPath } from "./files.js";
import {
  HOST_LIFECYCLE_LIMITS,
  type HostLifecycle,
  hostLifecycle,
  type IdlePriceQuote,
  type IdlePriceSource,
} from "./host-lifecycle.js";
import type { HostStreamTransport } from "./host-stream.js";
import { CheckpointMaintenance } from "./maintenance.js";
import {
  identityMemoryCodec,
  type MemoryChunkCodecAdapter,
} from "./memory-chunk-codec.js";
import type {
  MemoryCheckpointReceipt,
  SandboxRuntimeCapabilities,
} from "./memory-contracts.js";
import {
  type PortableMemoryOptions,
  portableMemoryOptions,
} from "./memory-contracts.js";
import {
  PortableMemoryRestore,
  type PortableRestoreResult,
} from "./memory-restore.js";
import { MemoryResumeCoordinator } from "./memory-resume.js";
import { PortableMemoryTransfer } from "./memory-transfer.js";
import { observeLifecycle } from "./observability.js";
import { OperationJournal } from "./operations.js";
import {
  type MissingPlacementRecovery,
  recoverMissingPlacement,
} from "./placement-recovery.js";
import {
  type HostLease,
  InsufficientHostLifetimeError,
  PoolJournal,
} from "./pool.js";
import type { MemoryChunkCodec } from "./portable-memory-format.js";
import { PortRegistry } from "./ports.js";
import { PreviewSessions } from "./preview-sessions.js";
import {
  DEFAULT_WORKLOAD_RESOURCES,
  type WorkloadResources,
  workloadResources,
} from "./resources.js";
import { restoreCheckpoint } from "./restore.js";
import {
  type MissingSourceRecovery,
  ShutdownCoordinator,
  type ShutdownMode,
} from "./shutdown.js";
import { StreamCoordinator } from "./streams.js";
import {
  type TerminalGeometry,
  type TerminalInput,
  TerminalInputJournal,
  terminalGeometry,
} from "./terminal-input.js";
import {
  observeCheckpointStore,
  type StageTimingSink,
  timeStage,
} from "./timing.js";
import { CheckpointTransfer } from "./transfer.js";
import { HOST_PROTOCOL_VERSION, type HostTransport } from "./transport.js";
import { UploadCoordinator } from "./uploads.js";

export type Sandbox = {
  id: string;
  owner: string;
  image: string;
  /** Absent only on records created before resource policy was persisted. */
  resources?: WorkloadResources;
  createOperation: string;
  placementOperation: string;
  restoreCheckpoint: string | null;
  pendingResume: string | null;
  phase:
    | "copying"
    | "queued"
    | "starting"
    | "running"
    | "stopping"
    | "stopped"
    | "quarantined"
    | "deleted";
  lease: HostLease | null;
  checkpoint: string | null;
  memory?: MemoryCheckpointReceipt | null;
  portableRestore?: string | null;
  memoryRecovery?: {
    operationId: string;
    memoryPreserved: boolean;
    reason: string;
  };
  generation: number;
  /** Last explicit loss acknowledgement; verify its operation before using it
   * to settle a client's old-generation business ownership. */
  sourceRecovery?: { operationId: string; fromGeneration: number };
};
type ResumeRecord = {
  generation: number;
  checkpointId: string;
  releaseId: string | null;
  placed: boolean;
};
type CommandRecord = {
  outcome?: Json;
  outputSnapshot?: Record<OutputChannel, InlineOutput | null>;
  terminal?: boolean;
  id: string;
  lease: HostLease;
  image: string;
  spec: { argv: string[]; cwd: string; timeout: number };
};

const EMPTY_COMMAND_OUTPUT: InlineOutput = {
  base64: "",
  sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
};

export type ManagerOptions = {
  poolId: string;
  /** Trusted bounded codecs for portable capture; identity is always available. */
  memoryCodecs?: ReadonlyMap<MemoryChunkCodec, MemoryChunkCodecAdapter>;
  streamTransport?: HostStreamTransport;
  approvedImages: string[];
  /** Operator policy for new sandboxes; existing records retain their limits. */
  workloadResources?: WorkloadResources;
  /** Explicit opt-in while automatic collection is awaiting release qualification. */
  automaticCollection?: boolean;
  /** Optional physical packing target; zero retains per-frame storage. */
  checkpointPackBytes?: number;
  /** Independent capture members: 256 KiB, 512 KiB or the default 1 MiB. */
  checkpointFrameBytes?: number;
  /** Opt-in combined quiesce/capture; old hosts safely use ordinary capture. */
  eagerCheckpointCapture?: boolean;
  /** Bounded wait for short noninteractive commands; zero returns immediately. */
  commandStartWaitMs?: number;
  /** Store tiny complete output channels in durable transactional metadata. Opt-in. */
  inlineCommandOutputBytes?: number;
  hostsPerOwner?: number;
  /** Retained sandbox identities per owner, including deleted history. */
  maxSandboxesPerOwner?: number;
  /** New host allocations snapshot this policy; existing slots keep theirs. */
  hostLifecycle?: HostLifecycle;
  idlePriceSource?: IdlePriceSource;
  now?: () => number;
  events?: EventSink;
  /** Optional monotonic, best-effort diagnostics; not lifecycle authority. */
  timings?: StageTimingSink;
};

/** Portable lifecycle coordinator; all principal scope is supplied by the caller's
 * identity boundary. Private host-control methods are never public API routes. */
export class SandboxManager {
  private readonly pool: PoolJournal;
  private readonly operations: OperationJournal;
  private readonly checkpoints: CheckpointRegistry;
  private readonly copies: CheckpointCopy;
  private readonly outputs: CommandOutputStore;
  private readonly activeOwners = new Set<string>();
  private readonly images: Set<string>;
  private readonly maxSandboxesPerOwner: number;
  private readonly resources: WorkloadResources;
  private readonly maintenance: CheckpointMaintenance | undefined;
  readonly history: CheckpointHistory;
  readonly ports: PortRegistry;
  readonly previewSessions: PreviewSessions;
  readonly streams: StreamCoordinator | undefined;
  readonly uploads: UploadCoordinator;
  private readonly terminalInputs: TerminalInputJournal;
  private readonly shutdown: ShutdownCoordinator;
  private readonly memoryCodecs: ReadonlyMap<
    MemoryChunkCodec,
    MemoryChunkCodecAdapter
  >;
  private readonly memoryResumes: MemoryResumeCoordinator;
  private readonly now: () => number;
  private readonly commandStartWaitMs: number;
  private readonly timings: StageTimingSink | undefined;
  private readonly lifecycle: HostLifecycle;
  private readonly idlePriceSource: IdlePriceSource | undefined;
  hostCapabilities() {
    return this.provider.capabilities();
  }
  constructor(
    private readonly state: StateStore,
    private readonly provider: HostProvider,
    private readonly transport: HostTransport,
    private readonly objects: CheckpointStore,
    options: ManagerOptions,
  ) {
    if (
      options.automaticCollection !== undefined &&
      typeof options.automaticCollection !== "boolean"
    )
      throw Error("Invalid automatic collection policy");
    if (
      options.eagerCheckpointCapture !== undefined &&
      typeof options.eagerCheckpointCapture !== "boolean"
    )
      throw Error("Invalid eager capture policy");
    this.maxSandboxesPerOwner = options.maxSandboxesPerOwner ?? 10000;
    if (
      !Number.isSafeInteger(this.maxSandboxesPerOwner) ||
      this.maxSandboxesPerOwner < 1 ||
      this.maxSandboxesPerOwner > 1000000
    )
      throw Error("Invalid sandbox identity bound");
    this.timings = options.timings;
    if (options.timings) {
      objects = observeCheckpointStore(objects, options.timings);
      this.objects = objects;
    }
    this.commandStartWaitMs =
      options.commandStartWaitMs ?? DEFAULTS.commandStartWaitMs;
    if (
      !Number.isSafeInteger(this.commandStartWaitMs) ||
      this.commandStartWaitMs < 0 ||
      this.commandStartWaitMs > DEFAULTS.maxCommandStartWaitMs
    )
      throw Error("Invalid command start wait");
    const frameBytes = options.checkpointFrameBytes ?? DEFAULTS.frameBytes;
    if (!(CAPTURE_FRAME_BYTES as readonly number[]).includes(frameBytes))
      throw Error("Invalid checkpoint capture frame size");
    const packBytes = options.checkpointPackBytes ?? 0;
    if (
      !Number.isSafeInteger(packBytes) ||
      packBytes < 0 ||
      packBytes > DEFAULTS.maxObjectBytes
    )
      throw Error("Invalid checkpoint pack target");
    this.resources = workloadResources(
      options.workloadResources === undefined
        ? DEFAULT_WORKLOAD_RESOURCES
        : options.workloadResources,
    );
    this.now = options.now ?? Date.now;
    if (options.events)
      state = observeLifecycle(state, options.events, this.now);
    this.state = state;
    const lifecycle = hostLifecycle(options.hostLifecycle);
    this.lifecycle = lifecycle;
    if (
      lifecycle.nativeIdle &&
      (!provider.idlePower ||
        !provider
          .capabilities()
          .features?.nativeIdleModes.includes(lifecycle.nativeIdle.mode))
    )
      throw Error("Native host sleep is unsupported by this provider");
    this.idlePriceSource = options.idlePriceSource;
    if (
      this.idlePriceSource &&
      typeof this.idlePriceSource.quote !== "function"
    )
      throw Error("Invalid idle price source");
    const maximum =
      provider.capabilities().maxLifetimeMs ?? DEFAULTS.hostLifetimeMs;
    if (
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      lifecycle.lifetimeMs > maximum
    )
      throw Error("Host lifetime exceeds provider capability");
    this.pool = new PoolJournal(
      state,
      options.poolId,
      this.now,
      () => crypto.randomUUID(),
      options.hostsPerOwner ?? 1,
      lifecycle,
    );
    this.operations = new OperationJournal(state, this.now);
    this.maintenance = options.automaticCollection
      ? new CheckpointMaintenance(
          state,
          (tx, scope) => {
            const sandbox = this.getIn(tx, scope);
            if (
              !sandbox ||
              sandbox.lease ||
              sandbox.pendingResume ||
              !["stopped", "deleted"].includes(sandbox.phase)
            )
              return;
            return { ...scope, generation: sandbox.generation };
          },
          (fence, id) => this.checkpoints.collect(fence, id),
          this.now,
        )
      : undefined;
    this.ports = new PortRegistry(state, this.operations, (tx, scope) => {
      const sandbox = tx.get<Sandbox>(this.key(scope));
      if (!sandbox) throw Error("Sandbox unavailable");
      return {
        generation: sandbox.generation,
        lease: sandbox.lease,
        image: sandbox.image,
        running: sandbox.phase === "running",
      };
    });
    this.previewSessions = new PreviewSessions(
      state,
      this.operations,
      this.ports,
      this.now,
    );
    if (options.streamTransport)
      this.streams = new StreamCoordinator(
        state,
        this.ports,
        this.operations,
        transport,
        options.streamTransport,
        this.now,
      );
    this.checkpoints = new CheckpointRegistry(state, objects, this.now);
    this.copies = new CheckpointCopy(state, this.checkpoints, objects);
    this.outputs = new CommandOutputStore(
      objects,
      this.checkpoints,
      options.inlineCommandOutputBytes ?? 0,
    );
    this.history = new CheckpointHistory(
      state,
      this.checkpoints,
      this.operations,
    );
    this.uploads = new UploadCoordinator(
      state,
      this.operations,
      (lease, action, payload) => this.request(lease, action, payload),
    );
    this.terminalInputs = new TerminalInputJournal(
      state,
      (lease, action, payload) => this.request(lease, action, payload),
    );
    this.memoryCodecs = new Map(
      options.memoryCodecs ?? [["identity", identityMemoryCodec]],
    );
    for (const [name, codec] of this.memoryCodecs)
      if (
        (name !== "identity" && name !== "gzip") ||
        codec.name !== name ||
        typeof codec.decode !== "function" ||
        typeof codec.encode !== "function"
      )
        throw Error("Invalid memory codec adapter");
    this.shutdown = new ShutdownCoordinator({
      ...(transport.memorySource
        ? {
            memorySource: (
              lease: HostLease,
              id: string,
              capture: import("./memory-capture.js").CapturedMemory,
              image: string,
            ) =>
              transport.memorySource!(
                lease.machineId,
                lease,
                id,
                capture,
                image,
              ),
          }
        : {}),
      memoryTransfer: new PortableMemoryTransfer(
        state,
        this.checkpoints,
        objects,
        this.memoryCodecs,
        undefined,
        options.timings,
      ),
      ...(transport.checkpointSource
        ? {
            checkpointSource: (
              lease: HostLease,
              archive: CapturedArchive,
              image: string,
            ) =>
              transport.checkpointSource!(
                lease.machineId,
                lease,
                archive,
                image,
              ),
          }
        : {}),
      captureFrameBytes: frameBytes,
      eagerCapture: options.eagerCheckpointCapture ?? false,
      ...(options.timings ? { timings: options.timings } : {}),
      settleUploads: (scope) => this.uploads.settle(scope),
      state,
      operations: this.operations,
      pool: this.pool,
      registry: this.checkpoints,
      objects,
      transfer: new CheckpointTransfer(objects, this.checkpoints, undefined, {
        packBytes,
      }),
      request: (lease, action, payload) => this.request(lease, action, payload),
      hostAbsent: async (lease) =>
        (await provider.inspect(lease.machineId)).state === "absent",
      settleStopped: async (scope, lease) => {
        await this.streams?.settleStopped(scope, lease);
        await this.terminalInputs.settle(scope);
      },
      retainCommands: async (scope, _lease, beforeUpload) => {
        const commands = await state.transaction((tx) =>
          tx
            .scan<CommandRecord>(`command/${scopeKey(scope)}/`)
            .map((row) => row.value),
        );
        const advertised = objects.transferConcurrency ?? 1;
        if (
          !Number.isSafeInteger(advertised) ||
          advertised < 1 ||
          advertised > DEFAULTS.maxTransferConcurrency
        )
          throw Error("Invalid command retention concurrency");
        // Command output can retain larger buffers than one prepared pack. Keep
        // its original two-command bound even when packed uploads opt into four.
        const concurrency = Math.min(advertised, DEFAULTS.transferConcurrency);
        for (let at = 0; at < commands.length; at += concurrency) {
          const settled = await Promise.allSettled(
            commands.slice(at, at + concurrency).map(async (command) => {
              const status = await this.commandStatus(scope, command.id);
              if (
                !status ||
                typeof status !== "object" ||
                Array.isArray(status)
              )
                throw Error("Invalid command receipt");
              if (["queued", "running"].includes(String(status.phase)))
                return false;
              await this.retainObservedCommand(
                scope,
                command,
                status,
                beforeUpload,
              );
              return true;
            }),
          );
          // Source cleanup cannot race a sibling still publishing output.
          const failure = settled.find(
            (result) => result.status === "rejected",
          );
          if (failure?.status === "rejected") throw failure.reason;
          if (
            settled.some(
              (result) => result.status === "fulfilled" && !result.value,
            )
          )
            return false;
        }
        return true;
      },
    });
    this.images = new Set(options.approvedImages);
    for (const image of this.images)
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(image))
        throw new Error("Approved image must be digest pinned");
    this.memoryResumes = new MemoryResumeCoordinator({
      state,
      objects,
      registry: this.checkpoints,
      operations: this.operations,
      pool: this.pool,
      request: (lease, action, payload) => this.request(lease, action, payload),
      hostAbsent: async (lease) =>
        (await provider.inspect(lease.machineId)).state === "absent",
    });
  }
  private key(scope: Scope) {
    return `sandbox/${scopeKey(scope)}`;
  }
  private uuid(value: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        value,
      )
    )
      throw new Error("UUID required");
    return value;
  }
  private checkAdmissionIn(tx: Transaction, owner: string) {
    if (
      tx.scan<Sandbox>(`sandbox/${owner}/`).length >= this.maxSandboxesPerOwner
    )
      throw Error("Owner sandbox identity bound reached");
  }
  async create(
    owner: string,
    id: string,
    image: string,
    operationId: string,
  ): Promise<Sandbox> {
    identifier(owner);
    this.uuid(id);
    this.uuid(operationId);
    if (!this.images.has(image)) throw new Error("Image not approved");
    const scope = { owner, sandbox: id };
    return this.state.transaction((tx) => {
      const fence = this.operations.generationIn(tx, scope);
      this.operations.admitIn(tx, fence, operationId, "create", { image });
      const previous = tx.get<Sandbox>(this.key(scope));
      if (previous) {
        if (
          previous.image !== image ||
          previous.createOperation !== operationId
        )
          throw new Error("Sandbox identity conflict");
        if (
          previous.phase === "queued" &&
          previous.placementOperation === operationId
        )
          this.pool.enqueueIn(tx, owner, id, operationId, { image });
        return previous;
      }
      this.checkAdmissionIn(tx, owner);
      const record: Sandbox = {
        id,
        owner,
        image,
        resources: { ...this.resources },
        createOperation: operationId,
        placementOperation: operationId,
        restoreCheckpoint: null,
        pendingResume: null,
        phase: "queued",
        lease: null,
        checkpoint: null,
        generation: 1,
      };
      tx.put(this.key(scope), record);
      this.pool.enqueueIn(tx, owner, id, operationId, { image });
      return record;
    });
  }
  /** Create a stopped sandbox from an independent copy of a retained filesystem
   * checkpoint. No host is allocated until an explicit resume. */
  async copyCheckpoint(
    owner: string,
    id: string,
    image: string,
    operationId: string,
    sourceSandbox: string,
    checkpointId: string,
  ): Promise<Sandbox> {
    identifier(owner);
    this.uuid(id);
    this.uuid(operationId);
    this.uuid(sourceSandbox);
    identifier(checkpointId);
    if (!this.images.has(image)) throw Error("Image not approved");
    if (id === sourceSandbox) throw Error("Copy requires a distinct sandbox");
    const scope = { owner, sandbox: id };
    return this.state.transaction((tx) => {
      const fence = this.operations.generationIn(tx, scope);
      const operation = this.operations.admitIn(
        tx,
        fence,
        operationId,
        "copy",
        {
          image,
          sourceSandbox,
          checkpointId,
        },
      );
      const previous = tx.get<Sandbox>(this.key(scope));
      if (previous) {
        if (
          previous.createOperation !== operationId ||
          previous.image !== image
        )
          throw Error("Sandbox identity conflict");
        return previous;
      }
      const source = tx.get<Sandbox>(
        this.key({ owner, sandbox: sourceSandbox }),
      );
      if (!source || source.phase === "deleted")
        throw Error("Copy source sandbox unavailable");
      this.copies.startIn(
        tx,
        { owner, sandbox: sourceSandbox, generation: source.generation },
        fence,
        operationId,
        checkpointId,
      );
      if (operation.phase !== "queued")
        throw Error("Copy admission unavailable");
      this.operations.claimIn(tx, fence, operationId);
      this.checkAdmissionIn(tx, owner);
      const record: Sandbox = {
        id,
        owner,
        image,
        resources: { ...this.resources },
        createOperation: operationId,
        placementOperation: operationId,
        restoreCheckpoint: null,
        pendingResume: null,
        phase: "copying",
        lease: null,
        checkpoint: null,
        generation: fence.generation,
      };
      tx.put(this.key(scope), record);
      return record;
    });
  }
  private async reconcileCopies(owner: string) {
    for (const sandbox of await this.list(owner)) {
      if (sandbox.phase !== "copying") continue;
      const scope = { owner, sandbox: sandbox.id },
        fence = { ...scope, generation: sandbox.generation };
      const copy = await this.copies.advance(fence, sandbox.createOperation);
      if (copy.phase === "copying") continue;
      await this.state.transaction((tx) => {
        const current = tx.get<Sandbox>(this.key(scope));
        if (
          !current ||
          current.phase !== "copying" ||
          current.generation !== fence.generation
        )
          throw Error("Copy authority changed");
        const deletion = tx.get<string>(`copy-delete/${scopeKey(scope)}`);
        const checkpoint = copy.phase === "published" ? copy.id : null;
        tx.put(this.key(scope), {
          ...current,
          phase: deletion ? "deleted" : "stopped",
          checkpoint,
        });
        this.operations.finishIn(tx, fence, current.createOperation, {
          phase: checkpoint ? "succeeded" : "failed",
          result: checkpoint ? { checkpointId: checkpoint } : null,
          error: checkpoint ? null : "Checkpoint copy cancelled",
        });
        if (deletion)
          this.operations.finishIn(tx, fence, deletion, {
            phase: "succeeded",
            result: { checkpointId: checkpoint },
            error: null,
          });
      });
    }
  }
  /** Read within an embedding client's transaction guard. This performs no
   * dispatch and does not replace the core's intrinsic admission fences. */
  getIn(tx: Pick<Transaction, "get">, scope: Scope): Sandbox | undefined {
    return tx.get<Sandbox>(this.key(scope));
  }
  async get(scope: Scope): Promise<Sandbox | undefined> {
    return this.state.transaction((tx) => this.getIn(tx, scope));
  }
  async list(owner: string): Promise<Sandbox[]> {
    identifier(owner);
    return this.state.transaction((tx) =>
      tx.scan<Sandbox>(`sandbox/${owner}/`).map((row) => row.value),
    );
  }
  async operation(scope: Scope, id: string) {
    return this.operations.get(scope, id);
  }
  async pendingOperations(scope: Scope, after = "", limit = 100) {
    if (after) identifier(after);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw Error("Invalid operation page size");
    const pending = (await this.operations.pending(scope))
      .filter((item) => item.id > after)
      .sort((a, b) => {
        if (a.id < b.id) return -1;
        return a.id > b.id ? 1 : 0;
      });
    const operations = pending.slice(0, limit);
    return {
      operations,
      next: pending.length > limit ? operations.at(-1)!.id : null,
    };
  }
  async owners(): Promise<string[]> {
    return this.state.transaction((tx) => [
      ...new Set(tx.scan<Sandbox>("sandbox/").map((row) => row.value.owner)),
    ]);
  }
  /** Called by a server worker or an embedded platform scheduler, never a browser. */
  async maintain(owner: string): Promise<number | null> {
    let nextAt = await this.pool.nextMaintenanceAt(owner);
    if (!this.maintenance) return nextAt;
    for (const sandbox of await this.list(owner)) {
      if (
        sandbox.lease ||
        sandbox.pendingResume ||
        !["stopped", "deleted"].includes(sandbox.phase)
      )
        continue;
      const scope = { owner, sandbox: sandbox.id };
      if (await this.checkpoints.inspect(scope)) {
        await this.maintenance.run(scope);
        const status = await this.maintenance.status(scope);
        if (status && (nextAt === null || status.dueAt < nextAt))
          nextAt = status.dueAt;
      }
    }
    return nextAt;
  }
  /** Operator-only composition surface, not a workload HTTP/SDK operation. */
  async setIdlePriceQuote(owner: string, quote: IdlePriceQuote): Promise<void> {
    await this.pool.setIdlePriceQuote(owner, quote);
  }
  /** Bounded best effort: a pricing outage cannot prevent normal reconciliation.
   * Both network I/O and the optional provider implementation stay outside tx. */
  async refreshIdlePrices(owner: string): Promise<boolean> {
    const source = this.idlePriceSource;
    if (!source || this.lifecycle.idle.mode !== "adaptive") return false;
    const id = await this.pool.claimIdlePriceRefresh(owner);
    if (!id) return false;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          abort.abort();
          resolve(undefined);
        }, HOST_LIFECYCLE_LIMITS.priceRequestMs);
      });
      const quote = await Promise.race([
        source.quote({ owner, now: this.now(), signal: abort.signal }),
        deadline,
      ]);
      return await this.pool.finishIdlePriceRefresh(owner, id, quote);
    } catch {
      return await this.pool.finishIdlePriceRefresh(owner, id);
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  }
  async maintenanceStatus(scope: Scope) {
    return this.maintenance?.status(scope);
  }
  private async request(
    lease: HostLease,
    action: string,
    payload: Json,
  ): Promise<Json> {
    return timeStage(
      this.timings,
      "control." + action,
      async () =>
        (
          await this.transport.request(lease.machineId, {
            version: HOST_PROTOCOL_VERSION,
            id: crypto.randomUUID(),
            action,
            payload,
          })
        ).result,
    );
  }
  private async restorePortable(
    sandbox: Sandbox,
    lease: HostLease,
  ): Promise<PortableRestoreResult> {
    if (
      !sandbox.portableRestore ||
      sandbox.portableRestore !== sandbox.restoreCheckpoint
    )
      throw Error("Portable placement checkpoint mismatch");
    return new PortableMemoryRestore(
      this.state,
      this.checkpoints,
      this.objects,
      this.timings,
    ).restore(
      {
        owner: sandbox.owner,
        sandbox: sandbox.id,
        generation: sandbox.generation,
      },
      sandbox.placementOperation,
      sandbox.portableRestore,
      lease,
      sandbox.image,
      workloadResources(sandbox.resources ?? DEFAULT_WORKLOAD_RESOURCES),
      (action, payload) =>
        this.request(lease, action, {
          ...(payload as Record<string, Json>),
          lease,
          image: sandbox.image,
        }),
      this.transport.checkpointImport
        ? () =>
            this.transport.checkpointImport!(
              lease.machineId,
              lease,
              sandbox.image,
            )
        : undefined,
      this.transport.memoryImport
        ? () =>
            this.transport.memoryImport!(
              lease.machineId,
              lease,
              sandbox.portableRestore!,
              sandbox.image,
            )
        : undefined,
    );
  }
  private async recoverObservedCreates(owner: string): Promise<void> {
    for (const slot of await this.pool.inspect(owner)) {
      const lease = slot.lease;
      if (!lease || !["assigned", "active", "quarantined"].includes(slot.phase))
        continue;
      const scope = { owner, sandbox: lease.sandboxId };
      const sandbox = await this.get(scope);
      if (!sandbox?.lease || canonical(sandbox.lease) !== canonical(lease))
        continue;
      const operation = await this.operations.get(
        scope,
        sandbox.placementOperation,
      );
      if (!operation || ["succeeded", "failed"].includes(operation.phase))
        continue;
      let observed: Json;
      let portableResult: PortableRestoreResult | undefined;
      try {
        if (sandbox.portableRestore)
          portableResult = await this.restorePortable(sandbox, lease);
        // Assignment may have committed before the first host RPC. Claim is
        // idempotent for this exact lease and never reopens a closed generation.
        await this.request(lease, "claim", { lease });
        observed = await this.request(lease, "inspect", { lease });
      } catch {
        continue;
      }
      if (
        !observed ||
        typeof observed !== "object" ||
        Array.isArray(observed) ||
        observed.phase !== "open" ||
        !observed.lease ||
        canonical(observed.lease) !== canonical(lease)
      )
        continue;
      // An absent runtime receipt proves no container creation was admitted.
      // File import is replayable by checkpoint identity and durable byte offset;
      // a creating/uncertain runtime receipt is never redispatched here.
      if (observed.runtime === undefined || observed.runtime === null) {
        if (sandbox.restoreCheckpoint && !portableResult)
          await restoreCheckpoint(
            this.objects,
            this.checkpoints,
            { ...scope, generation: sandbox.generation },
            sandbox.restoreCheckpoint,
            (action, payload) =>
              this.request(lease, action, {
                ...(payload as Record<string, Json>),
                lease,
                image: sandbox.image,
              }),
            this.transport.checkpointImport
              ? () =>
                  this.transport.checkpointImport!(
                    lease.machineId,
                    lease,
                    sandbox.image,
                  )
              : undefined,
          );
        await this.request(lease, "create", {
          lease,
          image: sandbox.image,
          ...workloadResources(sandbox.resources ?? DEFAULT_WORKLOAD_RESOURCES),
        });
        observed = await this.request(lease, "inspect", { lease });
        if (
          !observed ||
          typeof observed !== "object" ||
          Array.isArray(observed) ||
          observed.phase !== "open" ||
          canonical(observed.lease ?? null) !== canonical(lease)
        )
          continue;
      }
      const runtime = observed.runtime;
      if (
        !runtime ||
        typeof runtime !== "object" ||
        Array.isArray(runtime) ||
        runtime.phase !== "running" ||
        runtime.image !== sandbox.image
      )
        continue;
      const fence = await this.operations.generation(scope);
      if (operation.phase === "queued")
        await this.operations.claim(fence, operation.id);
      await this.pool.transition(lease, "active");
      await this.state.transaction((tx) => {
        const current = tx.get<Sandbox>(this.key(scope));
        if (!current?.lease || canonical(current.lease) !== canonical(lease))
          throw new Error("Recovery assignment changed");
        tx.put(this.key(scope), {
          ...current,
          phase: "running",
          ...(portableResult && current.memoryRecovery
            ? {
                memoryRecovery: {
                  ...current.memoryRecovery,
                  memoryPreserved: portableResult.memoryPreserved,
                  reason:
                    portableResult.fallbackReason ?? "portable-memory-restored",
                },
              }
            : {}),
        });
        if (current.restoreCheckpoint)
          this.checkpoints.releaseIn(
            tx,
            { ...scope, generation: current.generation },
            current.placementOperation,
          );
      });
      await this.operations.finish(fence, operation.id, {
        phase: "succeeded",
        result: { sandboxId: sandbox.id, ...(portableResult ?? {}) },
        error: null,
      });
    }
  }
  private async drainExpiringHosts(owner: string): Promise<void> {
    for (const slot of await this.pool.inspect(owner)) {
      if (!slot.lease || this.pool.drainAt(slot) > this.now()) continue;
      const lease = slot.lease,
        scope = { owner, sandbox: lease.sandboxId };
      await this.state.transaction((tx) => {
        const sandbox = tx.get<Sandbox>(this.key(scope));
        if (
          !sandbox?.lease ||
          canonical(sandbox.lease) !== canonical(lease) ||
          sandbox.pendingResume ||
          !["running", "stopped"].includes(sandbox.phase)
        )
          return;
        const key = `expiry-drain/${scopeKey(scope)}/${lease.assignmentId}`;
        if (tx.get(key)) return;
        const id = crypto.randomUUID();
        this.shutdown.admitIn(
          tx,
          { ...scope, generation: sandbox.generation },
          id,
          "stop",
        );
        tx.put(key, {
          operationId: id,
          expiresAt: slot.expiresAt,
          assignmentId: lease.assignmentId,
        });
      });
    }
  }
  /** Trusted operator shutdown: retire only released, owner-scoped idle slots.
   * Publication/cleanup remain prerequisites for a slot becoming idle. Unknown
   * acknowledgements keep the durable retirement intent for reconciliation. */
  async retireIdle(owner: string): Promise<void> {
    identifier(owner);
    for (const slot of await this.pool.inspect(owner)) {
      if (slot.phase === "idle" && !slot.lease && slot.machineId)
        await this.pool.retireIdle(slot.id, "shutdown");
    }
    await this.retireIdleHosts(owner);
  }
  private async retireIdleHosts(owner: string): Promise<void> {
    for (let slot of await this.pool.inspect(owner)) {
      if (slot.lease || !slot.machineId) continue;
      if (slot.phase === "idle" && this.pool.idleRetireAt(slot) <= this.now())
        slot = await this.pool.retireIdle(slot.id);
      if (slot.phase !== "quarantined" || !slot.machineId) continue;
      // Allocation identity fences provider retries. SSH releases only its
      // adoption record; cloud adapters must acknowledge actual retirement.
      await this.provider.retire(slot.machineId, slot.allocationId);
      await this.pool.retired(slot.id);
    }
  }
  private async reconcileNativeIdle(owner: string): Promise<void> {
    const power = this.provider.idlePower;
    if (!power) return;
    const queued = (await this.list(owner)).some((s) => s.phase === "queued");
    for (let slot of await this.pool.inspect(owner)) {
      if (slot.phase !== "idle" || slot.lease || !slot.machineId) continue;
      if (!slot.nativePower) {
        if (queued) continue;
        const admitted = await this.pool.claimNativePower(slot, false);
        if (!admitted) continue;
        slot = admitted;
      } else if (slot.nativePower.phase === "asleep") {
        if (!queued) continue;
        const admitted = await this.pool.claimNativePower(slot, true);
        if (!admitted) continue;
        slot = admitted;
      }
      const transition = slot.nativePower;
      if (!transition || !slot.machineId) continue;
      const input = {
        host: slot.machineId,
        owner: slot.owner,
        allocationId: slot.allocationId,
        operationId: transition.operationId,
        mode: transition.mode,
        expiresAt: slot.expiresAt,
      };
      const result =
        transition.phase === "sleeping"
          ? await power.sleep(input)
          : await power.wake(input);
      if (result === "absent") {
        await this.pool.retireMissingIdle(slot);
        await this.provider.retire(slot.machineId, slot.allocationId);
        await this.pool.retired(slot.id);
      } else if (result === "asleep" || result === "awake")
        await this.pool.finishNativePower(slot);
    }
  }
  /** Pending placement and running receipts survive restarts. Unknown remote
   * effects quarantine the source; they never trigger a second allocation. */
  async reconcile(owner: string): Promise<void> {
    if (this.activeOwners.has(owner)) return;
    this.activeOwners.add(owner);
    try {
      await this.refreshIdlePrices(owner);
      const cancellations = await this.state.transaction((tx) =>
        tx
          .scan<{ owner: string; sandbox: string; id: string; outcome: Json }>(
            `command-cancel/${identifier(owner)}/`,
          )
          .map((row) => row.value),
      );
      for (const cancel of cancellations)
        if (cancel.outcome === null)
          await this.cancelCommand(
            { owner: cancel.owner, sandbox: cancel.sandbox },
            cancel.id,
          );
      await this.terminalInputs.reconcile(owner);
      await this.memoryResumes.reconcile(owner);
      await this.recoverObservedCreates(owner);
      await this.drainExpiringHosts(owner);
      await this.shutdown.reconcile(owner);
      await this.uploads.reconcile(owner);
      await this.reconcileCopies(owner);
      await this.reconcileHeldResumes(owner);
      await this.retireIdleHosts(owner);
      await this.reconcileNativeIdle(owner);
      // Repair admission interrupted between sandbox, operation and queue commits.
      for (const sandbox of await this.list(owner))
        if (sandbox.phase === "queued") {
          const scope = { owner, sandbox: sandbox.id };
          const fence = await this.operations.generation(scope);
          await this.operations.admit(
            fence,
            sandbox.placementOperation,
            sandbox.restoreCheckpoint ? "resume" : "create",
            sandbox.restoreCheckpoint
              ? { checkpointId: sandbox.restoreCheckpoint }
              : { image: sandbox.image },
          );
          await this.pool.enqueue(
            owner,
            sandbox.id,
            sandbox.placementOperation,
            { image: sandbox.image },
          );
        }
      const readySlots = new Set<string>();
      const queued = (await this.list(owner)).some(
        (sandbox) => sandbox.phase === "queued",
      );
      if (queued) {
        for (const slot of await this.pool.inspect(owner)) {
          if (
            slot.phase !== "idle" ||
            slot.nativePower ||
            slot.lease ||
            !slot.machineId ||
            this.pool.drainAt(slot) <= this.now()
          )
            continue;
          const observed = await this.provider.inspect(slot.machineId);
          if (observed.state === "ready") readySlots.add(slot.id);
          else if (observed.state === "absent") {
            await this.pool.retireMissingIdle(slot);
            // Persist quarantine before retirement. A lost ACK keeps capacity
            // reserved; a restart reconciles the same owned allocation.
            await this.provider.retire(slot.machineId, slot.allocationId);
            await this.pool.retired(slot.id);
          }
          // Unknown/starting hosts keep their capacity and receive no assignment.
        }
      }
      const pendingAllocation = (await this.pool.inspect(owner)).find(
        (slot) => slot.phase === "allocating",
      );
      const reserved = pendingAllocation ?? (await this.pool.reserve(owner));
      const reservation = reserved
        ? await this.pool.dispatchAllocation(reserved.id, owner)
        : undefined;
      if (reservation) {
        const allocated = await this.provider.allocate({
          owner,
          operationId: reservation.allocationId,
          expiresAt: reservation.expiresAt,
        });
        if ((await this.provider.inspect(allocated.id)).state !== "ready")
          return;
        await this.pool.provisioned(
          reservation.id,
          owner,
          allocated.id,
          allocated.allocationId,
        );
        readySlots.add(reservation.id);
      }
      const assignment = await this.pool.assign(
        owner,
        (tx, ticket, lease) => {
          const scope = { owner, sandbox: ticket.sandboxId };
          const sandbox = tx.get<Sandbox>(this.key(scope));
          if (
            !sandbox ||
            sandbox.phase !== "queued" ||
            sandbox.lease ||
            sandbox.placementOperation !== ticket.id
          )
            throw Error("Placement sandbox authority changed");
          const fence = this.operations.generationIn(tx, scope);
          if (!this.operations.claimIn(tx, fence, ticket.id))
            throw Error("Placement operation already dispatched");
          tx.put(this.key(scope), { ...sandbox, phase: "starting", lease });
        },
        readySlots,
      );
      if (!assignment) return;
      const { lease, ticket } = assignment;
      const scope = { owner, sandbox: ticket.sandboxId };
      const sandbox = await this.get(scope);
      if (!sandbox) throw new Error("Placement sandbox missing");
      const operationFence = await this.operations.generation(scope);
      try {
        await this.checkpoints.initialize({
          ...scope,
          generation: sandbox.generation,
        });
        const resources = workloadResources(
          sandbox.resources ?? DEFAULT_WORKLOAD_RESOURCES,
        );
        const portableResult = sandbox.portableRestore
          ? await this.restorePortable(sandbox, lease)
          : undefined;
        const restoreCheckpointId = sandbox.restoreCheckpoint;
        const resumedCached =
          restoreCheckpointId && !portableResult
            ? await timeStage(this.timings, "resume.cached", () =>
                resumeCachedCheckpoint(
                  this.checkpoints,
                  { ...scope, generation: sandbox.generation },
                  lease,
                  sandbox.image,
                  resources,
                  restoreCheckpointId,
                  this.transport,
                ),
              )
            : false;
        if (!resumedCached && !portableResult?.memoryPreserved) {
          await this.request(lease, "claim", { lease });
          if (sandbox.restoreCheckpoint && !portableResult)
            await restoreCheckpoint(
              this.objects,
              this.checkpoints,
              { ...scope, generation: sandbox.generation },
              sandbox.restoreCheckpoint,
              (action, payload) =>
                this.request(lease, action, {
                  ...(payload as Record<string, Json>),
                  lease,
                  image: sandbox.image,
                }),
              this.transport.checkpointImport
                ? () =>
                    this.transport.checkpointImport!(
                      lease.machineId,
                      lease,
                      sandbox.image,
                    )
                : undefined,
            );
          await this.request(lease, "create", {
            lease,
            image: sandbox.image,
            ...resources,
          });
        }
        await this.pool.transition(lease, "active");
        await this.state.transaction((tx) => {
          const current = tx.get<Sandbox>(this.key(scope));
          if (!current?.lease || canonical(current.lease) !== canonical(lease))
            throw new Error("Sandbox assignment changed");
          tx.put(this.key(scope), {
            ...current,
            phase: "running",
            ...(portableResult && current.memoryRecovery
              ? {
                  memoryRecovery: {
                    ...current.memoryRecovery,
                    memoryPreserved: portableResult.memoryPreserved,
                    reason:
                      portableResult.fallbackReason ??
                      "portable-memory-restored",
                  },
                }
              : {}),
          });
          if (current.restoreCheckpoint)
            this.checkpoints.releaseIn(
              tx,
              { ...scope, generation: current.generation },
              current.placementOperation,
            );
        });
        await this.operations.finish(operationFence, ticket.id, {
          phase: "succeeded",
          result: { sandboxId: sandbox.id, ...(portableResult ?? {}) },
          error: null,
        });
      } catch (error) {
        await this.pool.transition(lease, "quarantined");
        await this.state.transaction((tx) => {
          const current = tx.get<Sandbox>(this.key(scope));
          if (current?.lease && canonical(current.lease) === canonical(lease))
            tx.put(this.key(scope), { ...current, phase: "quarantined" });
        });
        await this.operations.finish(operationFence, ticket.id, {
          phase: "uncertain",
          result: null,
          error: "Host lifecycle requires reconciliation",
        });
        throw error;
      }
    } finally {
      try {
        await this.streams?.reconcileOwner(owner);
      } finally {
        this.activeOwners.delete(owner);
      }
    }
  }
  private async reconcileHeldResumes(owner: string) {
    const pending = await this.state.transaction((tx) =>
      tx
        .scan<ResumeRecord>(`resume/${owner}/`)
        .filter((row) => !row.value.placed),
    );
    for (const row of pending) {
      const [, recordOwner, sandboxId, id] = row.key.split("/");
      if (!recordOwner || !sandboxId || !id || !row.value.releaseId)
        throw Error("Invalid resume intent");
      const scope = { owner: recordOwner, sandbox: sandboxId };
      const release = await this.operations.get(scope, row.value.releaseId);
      if (release?.phase !== "succeeded") continue;
      await this.state.transaction((tx) => {
        const intent = tx.get<ResumeRecord>(row.key);
        if (!intent || intent.placed) return;
        const sandbox = tx.get<Sandbox>(this.key(scope));
        if (
          !sandbox ||
          sandbox.phase !== "stopped" ||
          sandbox.lease ||
          sandbox.pendingResume !== id ||
          sandbox.generation !== intent.generation ||
          sandbox.checkpoint !== intent.releaseId
        )
          throw Error("Resume release authority changed");
        const fence = { ...scope, generation: intent.generation };
        const next = this.checkpoints.advanceIn(tx, fence);
        this.operations.advanceIn(tx, fence);
        this.operations.rebaseQueuedIn(tx, next, id, fence.generation);
        tx.put(row.key, {
          ...intent,
          generation: next.generation,
          placed: true,
        });
        tx.put(this.key(scope), {
          ...sandbox,
          phase: "queued",
          generation: next.generation,
          placementOperation: id,
          restoreCheckpoint: intent.checkpointId,
          portableRestore: null,
          pendingResume: null,
        });
      });
    }
  }
  async resume(scope: Scope, id: string, checkpointId?: string) {
    this.uuid(id);
    if (checkpointId !== undefined) identifier(checkpointId);
    await this.state.transaction((tx) => {
      const prior = tx.get<ResumeRecord>(`resume/${scopeKey(scope)}/${id}`);
      if (prior) {
        if (checkpointId !== undefined && checkpointId !== prior.checkpointId)
          throw Error("Resume checkpoint identity conflict");
        return prior;
      }
      const sandbox = tx.get<Sandbox>(this.key(scope));
      if (
        !sandbox ||
        sandbox.phase !== "stopped" ||
        sandbox.pendingResume ||
        !sandbox.checkpoint
      )
        throw Error("Resume requires a durably released checkpoint");
      const fence = { ...scope, generation: sandbox.generation };
      const selected = checkpointId ?? sandbox.checkpoint;
      const root = this.checkpoints
        .rootsIn(tx, fence)
        .find((root) => root.id === selected && root.retiredAt === null);
      if (!root) throw Error("Restore checkpoint unavailable");
      checkpointArchive(root);
      this.checkpoints.holdIn(tx, fence, id, selected);
      if (sandbox.lease) {
        const releaseId = crypto.randomUUID();
        this.operations.admitIn(tx, fence, id, "resume", {
          checkpointId: selected,
        });
        this.shutdown.admitIn(tx, fence, releaseId, "stop");
        const current = tx.get<Sandbox>(this.key(scope))!;
        tx.put(this.key(scope), { ...current, pendingResume: id });
        const record: ResumeRecord = {
          generation: fence.generation,
          checkpointId: selected,
          releaseId,
          placed: false,
        };
        tx.put(`resume/${scopeKey(scope)}/${id}`, record);
        return record;
      }
      const next = this.checkpoints.advanceIn(tx, fence);
      this.operations.advanceIn(tx, fence);
      this.operations.admitIn(tx, next, id, "resume", {
        checkpointId: selected,
      });
      const record = {
        generation: next.generation,
        checkpointId: selected,
        releaseId: null,
        placed: true,
      };
      tx.put(`resume/${scopeKey(scope)}/${id}`, record);
      tx.put(this.key(scope), {
        ...sandbox,
        generation: next.generation,
        phase: "queued",
        placementOperation: id,
        restoreCheckpoint: selected,
        portableRestore: null,
      });
      return record;
    });
    return this.get(scope);
  }
  async deleteSandbox(scope: Scope, id: string) {
    this.uuid(id);
    const sandbox = await this.get(scope);
    if (!sandbox) throw Error("Sandbox unavailable");
    if (sandbox.phase === "copying")
      return this.state.transaction((tx) => {
        const current = tx.get<Sandbox>(this.key(scope));
        if (!current || current.phase !== "copying")
          throw Error("Copy transition changed; retry deletion");
        const fence = { ...scope, generation: current.generation };
        const key = `copy-delete/${scopeKey(scope)}`,
          prior = tx.get<string>(key);
        if (prior && prior !== id) throw Error("Deletion identity conflict");
        const operation = this.operations.admitIn(tx, fence, id, "delete", {});
        this.operations.claimIn(tx, fence, id);
        this.copies.cancelIn(tx, fence, current.createOperation);
        tx.put(key, id);
        return operation;
      });
    if (sandbox.pendingResume) throw Error("Resume transition pending");
    if (sandbox.lease) return this.shutdown.admit(scope, id, "delete");
    const fence = await this.operations.generation(scope);
    return this.state.transaction((tx) => {
      const current = tx.get<Sandbox>(this.key(scope));
      if (
        !current ||
        current.lease ||
        current.pendingResume ||
        !["queued", "stopped", "deleted"].includes(current.phase)
      )
        throw Error("Sandbox deletion requires resolved placement");
      const operation = this.operations.admitIn(tx, fence, id, "delete", {});
      if (operation.phase === "succeeded") return operation;
      if (current.phase === "queued") {
        this.pool.cancelQueuedIn(
          tx,
          scope.owner,
          scope.sandbox,
          current.placementOperation,
          { image: current.image },
        );
        this.operations.cancelQueuedIn(tx, fence, current.placementOperation);
        if (current.restoreCheckpoint)
          this.checkpoints.releaseIn(tx, fence, current.placementOperation);
      }
      this.operations.claimIn(tx, fence, id);
      tx.put(this.key(scope), { ...current, phase: "deleted" });
      return this.operations.finishIn(tx, fence, id, {
        phase: "succeeded",
        result: { checkpointId: current.checkpoint },
        error: null,
      });
    });
  }
  async recoverMissingPlacement(
    scope: Scope,
    id: string,
    input: MissingPlacementRecovery,
  ) {
    this.uuid(id);
    return recoverMissingPlacement(
      {
        state: this.state,
        provider: this.provider,
        objects: this.objects,
        registry: this.checkpoints,
        operations: this.operations,
        pool: this.pool,
      },
      scope,
      id,
      input,
    );
  }
  async recoverMissingSource(
    scope: Scope,
    id: string,
    input: MissingSourceRecovery,
  ) {
    this.uuid(id);
    return this.shutdown.recoverMissingSource(scope, id, input);
  }
  async runtimeCapabilities(scope: Scope): Promise<SandboxRuntimeCapabilities> {
    const sandbox = await this.get(scope);
    if (!sandbox) throw Error("Sandbox missing");
    if (!sandbox.lease)
      return {
        runtimeKind: null,
        memorySuspendVersion: null,
        portableMemoryVersion: null,
      };
    const status = await this.request(sandbox.lease, "status", {});
    if (!status || typeof status !== "object" || Array.isArray(status))
      throw Error("Invalid runtime capabilities");
    const kind = status.runtimeKind;
    if (kind !== "podman" && kind !== "gvisor")
      throw Error("Invalid runtime kind");
    return {
      runtimeKind: kind,
      memorySuspendVersion: status.memorySuspendVersion === 1 ? 1 : null,
      portableMemoryVersion: status.portableMemoryVersion === 1 ? 1 : null,
    };
  }
  async resumeMemory(scope: Scope, id: string) {
    this.uuid(id);
    return this.memoryResumes.admit(scope, id);
  }
  async suspend(scope: Scope, id: string, portable?: PortableMemoryOptions) {
    this.uuid(id);
    if (portable) {
      portable = portableMemoryOptions(portable);
      if (!this.memoryCodecs.has(portable.codec))
        throw Error("Portable memory codec unavailable");
    }
    const prior = await this.operations.get(scope, id);
    if (prior) {
      if (
        prior.kind !== "suspend" ||
        canonical(prior.input) !== canonical(portable ? { portable } : {})
      )
        throw Error("Operation identity conflict");
      return prior;
    }
    const sandbox = await this.get(scope);
    if (!sandbox?.lease || sandbox.phase !== "running")
      throw Error("Sandbox not running");
    const capabilities = await this.request(sandbox.lease, "status", {});
    if (
      !capabilities ||
      typeof capabilities !== "object" ||
      Array.isArray(capabilities) ||
      capabilities.memorySuspendVersion !== 1
    )
      throw Error("Memory suspend not supported by this host");
    if (portable && capabilities.portableMemoryVersion !== 1)
      throw Error("Portable memory not supported by this host");
    return this.shutdown.admit(scope, id, "suspend", portable);
  }
  async stop(scope: Scope, id: string, mode: ShutdownMode = "stop") {
    this.uuid(id);
    if (mode !== "stop" && mode !== "checkpoint")
      throw Error("Invalid shutdown mode");
    const completed = await this.state.transaction((tx) => {
      const fence = this.operations.generationIn(tx, scope);
      const prior = this.operations.getIn(tx, scope, id);
      if (prior) {
        if (prior.kind !== mode || canonical(prior.input) !== canonical({}))
          throw Error("Operation identity conflict");
        // A replay observes the old outcome even if a newer resume now runs.
        if (prior.phase === "succeeded" || prior.phase === "failed")
          return prior;
      }
      const sandbox = tx.get<Sandbox>(this.key(scope));
      if (
        !sandbox ||
        sandbox.lease ||
        sandbox.pendingResume ||
        !["queued", "stopped"].includes(sandbox.phase) ||
        !sandbox.checkpoint
      )
        return null;
      const root = this.checkpoints
        .rootsIn(tx, fence)
        .find(
          (entry) =>
            entry.id === sandbox.checkpoint && entry.retiredAt === null,
        );
      if (!root) throw Error("Stopped checkpoint unavailable");
      this.operations.admitIn(tx, fence, id, mode, {});
      if (sandbox.phase === "queued") {
        if (!sandbox.restoreCheckpoint)
          throw Error("Queued creation has no durable checkpoint");
        // This shares the pool assignment transaction. An assigned ticket rejects
        // cancellation, retaining ownership until ordinary fenced teardown.
        this.pool.cancelQueuedIn(
          tx,
          scope.owner,
          scope.sandbox,
          sandbox.placementOperation,
          { image: sandbox.image },
        );
        this.operations.cancelQueuedIn(tx, fence, sandbox.placementOperation);
        this.checkpoints.releaseIn(tx, fence, sandbox.placementOperation);
      }
      this.operations.claimIn(tx, fence, id);
      tx.put(this.key(scope), {
        ...sandbox,
        phase: "stopped",
        restoreCheckpoint: null,
      });
      return this.operations.finishIn(tx, fence, id, {
        phase: "succeeded",
        result: { checkpointId: sandbox.checkpoint },
        error: null,
      });
    });
    return completed ?? this.shutdown.admit(scope, id, mode);
  }
  async startCommand(
    scope: Scope,
    id: string,
    argv: string[],
    cwd = "/workspace",
    timeout = 120,
    terminal = false,
    geometry?: TerminalGeometry,
  ): Promise<Json> {
    this.uuid(id);
    if (typeof terminal !== "boolean") throw Error("Invalid terminal mode");
    const spec = terminal
      ? { argv, cwd, timeout, ...terminalGeometry(geometry) }
      : { argv, cwd, timeout };
    const admission = await this.state.transaction((tx) => {
      const key = `command/${scopeKey(scope)}/${id}`;
      const prior = tx.get<CommandRecord>(key);
      if (prior) {
        if (
          canonical(prior.spec) !== canonical(spec) ||
          (prior.terminal === true) !== terminal
        )
          throw new Error("Command identity conflict");
        return { record: prior, fresh: false };
      }
      const sandbox = tx.get<Sandbox>(this.key(scope));
      if (!sandbox?.lease || sandbox.phase !== "running")
        throw new Error("Sandbox not running");
      let denial: string | undefined;
      try {
        this.pool.admitExecutionIn(tx, sandbox.lease, timeout);
      } catch (error) {
        if (!(error instanceof InsufficientHostLifetimeError)) throw error;
        denial = error.message;
      }
      const record: CommandRecord = {
        terminal,
        id,
        lease: sandbox.lease,
        image: sandbox.image,
        spec,
        ...(denial
          ? {
              outcome: {
                id,
                phase: "failed",
                exitCode: null,
                neverStarted: true,
                reason: "insufficient_host_lifetime",
                failureStage: "admission",
              },
              outputSnapshot: {
                stdout: EMPTY_COMMAND_OUTPUT,
                stderr: EMPTY_COMMAND_OUTPUT,
              },
            }
          : {}),
      };
      tx.put(key, record);
      return { record, fresh: true, denial };
    });
    // Persist an explicit pre-dispatch rejection before returning the error.
    // A launcher that already saved its intent can observe this exact identity
    // after a lost reply, rather than confuse denied work with an unknown launch.
    if (admission.denial) throw new InsufficientHostLifetimeError();
    // Persist before crossing the host boundary. Even a controller crash before
    // dispatch is uncertain: reconnect observes this ID and never reexecutes it.
    if (!admission.fresh) return this.commandStatus(scope, id);
    const result = await this.request(
      admission.record.lease,
      terminal ? "terminal-start" : "command-start",
      {
        lease: admission.record.lease,
        image: admission.record.image,
        commandId: id,
        waitMs: terminal ? 0 : this.commandStartWaitMs,
        ...spec,
      },
    );
    return this.rememberTerminal(scope, admission.record, result);
  }
  async startTerminal(
    scope: Scope,
    id: string,
    argv: string[],
    cwd = "/workspace",
    timeout = 120,
    geometry?: TerminalGeometry,
  ): Promise<Json> {
    return this.startCommand(scope, id, argv, cwd, timeout, true, geometry);
  }
  async requireTerminal(scope: Scope, id: string): Promise<void> {
    if (!(await this.command(scope, id)).terminal)
      throw Error("Terminal unavailable");
  }
  async terminalInput(
    scope: Scope,
    commandId: string,
    id: string,
    input: TerminalInput,
  ): Promise<Json> {
    this.uuid(id);
    const command = await this.command(scope, commandId);
    if (!command.terminal) throw Error("Terminal unavailable");
    return this.terminalInputs.admit(
      {
        ...scope,
        command: commandId,
        id,
        lease: command.lease,
        image: command.image,
      },
      input,
      (tx) => {
        const sandbox = tx.get<Sandbox>(this.key(scope));
        if (
          !sandbox ||
          sandbox.phase !== "running" ||
          canonical(sandbox.lease) !== canonical(command.lease)
        )
          throw Error("Terminal not running");
      },
    );
  }
  async terminalInputStatus(
    scope: Scope,
    commandId: string,
    id: string,
  ): Promise<Json> {
    this.uuid(id);
    const command = await this.command(scope, commandId);
    if (!command.terminal) throw Error("Terminal unavailable");
    return this.terminalInputs.status(scope, commandId, id);
  }
  async readFile(
    scope: Scope,
    path: string,
    offset = 0,
    bytes = FILE_CHUNK_BYTES,
    expectedVersion?: string,
  ): Promise<Json> {
    persistentPath(path);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > FILE_CHUNK_BYTES
    )
      throw Error("Invalid file range");
    const sandbox = await this.get(scope);
    if (!sandbox?.lease || sandbox.phase !== "running" || sandbox.pendingResume)
      throw Error("Sandbox unavailable");
    return this.request(sandbox.lease, "file-read", {
      lease: sandbox.lease,
      image: sandbox.image,
      path,
      offset,
      bytes,
      expectedVersion: expectedVersion ?? null,
    });
  }
  async listFiles(
    scope: Scope,
    path: string,
    after = "",
    limit = 256,
    expectedVersion?: string,
  ): Promise<Json> {
    persistentPath(path);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 256 ||
      after.includes("/") ||
      after.includes("\0") ||
      new TextEncoder().encode(after).length > 255
    )
      throw Error("Invalid listing range");
    const sandbox = await this.get(scope);
    if (!sandbox?.lease || sandbox.phase !== "running" || sandbox.pendingResume)
      throw Error("Sandbox unavailable");
    return this.request(sandbox.lease, "file-list", {
      lease: sandbox.lease,
      image: sandbox.image,
      path,
      after,
      limit,
      expectedVersion: expectedVersion ?? null,
    });
  }
  private async command(scope: Scope, id: string) {
    this.uuid(id);
    const command = await this.state.transaction((tx) =>
      tx.get<CommandRecord>(`command/${scopeKey(scope)}/${id}`),
    );
    if (!command) throw new Error("Command unavailable");
    return command;
  }
  /** The command ID also identifies its one durable cancellation intent. */
  async cancelCommand(scope: Scope, id: string): Promise<Json> {
    const command = await this.command(scope, id);
    const key = `command-cancel/${scopeKey(scope)}/${id}`;
    const row = await this.state.transaction((tx) => {
      const prior = tx.get<{
        owner: string;
        sandbox: string;
        id: string;
        outcome: Json;
      }>(key);
      if (prior) return prior;
      const value = { ...scope, id, outcome: null };
      tx.put(key, value);
      return value;
    });
    if (row.outcome !== null) return row.outcome;
    let result = await this.commandStatus(scope, id);
    const terminal = (value: Json) =>
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      ["succeeded", "failed", "cancelled", "uncertain"].includes(
        String(value.phase),
      );
    if (!terminal(result))
      result = await this.request(command.lease, "command-cancel", {
        lease: command.lease,
        image: command.image,
        commandId: id,
      });
    if (terminal(result))
      await this.state.transaction((tx) =>
        tx.put(key, { ...row, outcome: result }),
      );
    return result;
  }
  private async rememberTerminal(
    scope: Scope,
    command: CommandRecord,
    result: Json,
  ): Promise<Json> {
    if (!result || typeof result !== "object" || Array.isArray(result))
      return result;
    if (!["succeeded", "failed", "cancelled"].includes(String(result.phase))) {
      if (Object.hasOwn(result, "outputSnapshot"))
        throw Error("Unsettled command output snapshot");
      return result;
    }
    result = structuredClone(result);
    if (result.id !== command.id)
      throw Error("Command outcome identity conflict");
    let outputSnapshot: Record<OutputChannel, InlineOutput | null> | undefined;
    if (Object.hasOwn(result, "outputSnapshot")) {
      const raw = result.outputSnapshot;
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        Object.keys(raw).sort().join(",") !== "channels,version" ||
        raw.version !== 1 ||
        !raw.channels ||
        typeof raw.channels !== "object" ||
        Array.isArray(raw.channels) ||
        Object.keys(raw.channels).sort().join(",") !== "stderr,stdout"
      )
        throw Error("Invalid command output snapshot");
      outputSnapshot = { stdout: null, stderr: null };
      for (const channel of OUTPUT_CHANNELS) {
        const proof = raw.channels[channel];
        if (proof === null) continue;
        await verifyOutputProof(proof as InlineOutput, true);
        outputSnapshot[channel] = structuredClone(proof) as InlineOutput;
      }
      result = { ...result };
      delete result.outputSnapshot;
    }
    const status = result;
    await this.state.transaction((tx) => {
      const key = `command/${scopeKey(scope)}/${command.id}`,
        current = tx.get<CommandRecord>(key);
      if (
        !current ||
        canonical(current.lease) !== canonical(command.lease) ||
        canonical(current.spec) !== canonical(command.spec)
      )
        throw Error("Command authority changed");
      if (
        current.outcome !== undefined &&
        canonical(current.outcome) !== canonical(status)
      )
        throw Error("Command outcome identity conflict");
      if (
        outputSnapshot &&
        current.outputSnapshot &&
        canonical(outputSnapshot) !== canonical(current.outputSnapshot)
      )
        throw Error("Command output identity conflict");
      if (
        current.outcome === undefined ||
        (outputSnapshot && !current.outputSnapshot)
      )
        tx.put(key, {
          ...current,
          outcome: structuredClone(status),
          ...(outputSnapshot
            ? { outputSnapshot: structuredClone(outputSnapshot) }
            : {}),
        });
    });
    return status;
  }
  private async readCommandSource(
    command: CommandRecord,
    channel: OutputChannel,
    offset: number,
    bytes: number,
  ): Promise<Json> {
    if (
      !OUTPUT_CHANNELS.includes(channel) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > OUTPUT_CHUNK
    )
      throw Error("Invalid command output range");
    const proof = command.outputSnapshot?.[channel];
    if (proof) {
      if (
        !command.outcome ||
        typeof command.outcome !== "object" ||
        Array.isArray(command.outcome) ||
        !["succeeded", "failed", "cancelled"].includes(
          String(command.outcome.phase),
        )
      )
        throw Error("Command snapshot outcome missing");
      const data = await verifyOutputProof(proof, true);
      if (offset > data.length) throw Error("Output cursor beyond end");
      const part = data.subarray(offset, offset + bytes);
      return {
        base64: encodeBase64(part),
        nextOffset: offset + part.length,
        terminal: offset + part.length === data.length,
      };
    }
    return this.request(command.lease, "command-output", {
      lease: command.lease,
      image: command.image,
      commandId: command.id,
      channel,
      offset,
      bytes,
    });
  }
  async commandStatus(scope: Scope, id: string): Promise<Json> {
    const command = await this.command(scope, id);
    if (command.outcome !== undefined) return command.outcome;
    const sandbox = await this.get(scope);
    if (!sandbox) throw new Error("Sandbox unavailable");
    const retained = await this.outputs.retained(
      { ...scope, generation: sandbox.generation },
      id,
    );
    if (retained !== undefined) return retained;
    const result = await this.request(command.lease, "command-status", {
      lease: command.lease,
      image: command.image,
      commandId: id,
    });
    return this.rememberTerminal(scope, command, result);
  }
  /** Called by lifecycle reconciliation before host release. A failed transfer
   * keeps its writer admission, preventing collection and successful release. */
  async retainCommand(scope: Scope, id: string): Promise<void> {
    const command = await this.command(scope, id);
    const status = await this.commandStatus(scope, id);
    await this.retainObservedCommand(scope, command, status);
  }
  private async retainObservedCommand(
    scope: Scope,
    command: CommandRecord,
    status: Json,
    beforeUpload?: () => void,
  ): Promise<void> {
    const sandbox = await this.get(scope);
    if (!sandbox) throw new Error("Sandbox unavailable");
    await this.outputs.retain(
      { ...scope, generation: sandbox.generation },
      command.id,
      status,
      (channel, offset, bytes) =>
        this.readCommandSource(command, channel, offset, bytes),
      beforeUpload,
    );
  }
  async commandOutput(
    scope: Scope,
    id: string,
    channel: OutputChannel,
    offset: number,
    bytes: number,
  ): Promise<Json> {
    const command = await this.command(scope, id);
    const sandbox = await this.get(scope);
    if (!sandbox) throw new Error("Sandbox unavailable");
    const fence = { ...scope, generation: sandbox.generation };
    if ((await this.outputs.retained(fence, id)) !== undefined)
      return this.outputs.read(fence, id, channel, offset, bytes);
    return this.readCommandSource(command, channel, offset, bytes);
  }
}
