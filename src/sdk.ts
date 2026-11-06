import { readFileChunks, writeFileChunks } from "./client/files.js";
import {
  type CreateOptions,
  type FromCheckpointOptions,
  type JetskiOptions,
  SandboxSession,
  sandboxSession,
  sessionDeadline,
} from "./client/sandbox.js";
import {
  type CheckpointContent,
  checkpointContent,
} from "./core/checkpoint-content.js";

export {
  type CommandResult,
  type CreateOptions,
  type ExecOptions,
  type FromCheckpointOptions,
  JetskiCommandError,
  JetskiOperationError,
  type JetskiOptions,
  type OperationOptions,
  type SandboxApi,
  type SandboxOperation,
  SandboxSession,
  type SessionOptions,
} from "./client/sandbox.js";

import { TerminalAttachment } from "./client/terminal.js";
import {
  type OperationWaitOptions,
  observationDelay,
  observeOperation,
} from "./client/wait.js";

export {
  OperationOutcomeError,
  type OperationWaitOptions,
} from "./client/wait.js";

import type {
  CheckpointPage,
  CheckpointSummary,
} from "./core/checkpoint-history.js";
import {
  decodeBase64,
  encodeBase64,
  OUTPUT_CHUNK,
  OUTPUT_LIMIT,
} from "./core/command-output.js";
import type { StateStore } from "./core/contracts.js";
import { identifier, type Json, type Operation } from "./core/contracts.js";
import {
  FILE_CHUNK_BYTES,
  type FileChunk,
  type FileListing,
  persistentPath,
} from "./core/files.js";
import type { Sandbox, SandboxManager } from "./core/manager.js";
import {
  type PortableMemoryOptions,
  portableMemoryOptions,
  type SandboxRuntimeCapabilities,
} from "./core/memory-contracts.js";
import {
  type MissingPlacementRecovery,
  missingPlacementRecovery,
} from "./core/placement-recovery.js";
import {
  type MissingSourceRecovery,
  missingSourceRecovery,
} from "./core/shutdown.js";
import {
  type TerminalGeometry,
  type TerminalInput,
  terminalGeometry,
} from "./core/terminal-input.js";
import type { UploadSpec, UploadStatus } from "./core/uploads.js";
export class JetskiHttpError extends Error {
  constructor(readonly status: number) {
    super(`Jetski request failed (${status})`);
  }
}
export class JetskiClient {
  private readonly base: URL;
  constructor(
    url: string,
    private readonly token: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    // Invoke fetch as a function, not as a method of this client instance.
    this.transport = (input, init) => transport(input, init);
    this.base = new URL(url);
    if (
      this.base.protocol !== "https:" &&
      !(
        this.base.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(this.base.hostname)
      )
    )
      throw new Error("HTTPS required outside loopback");
    if (this.base.username || this.base.password)
      throw new Error("URL credentials prohibited");
  }
  createPreviewGrant(
    sandbox: string,
    exposureId: string,
    origin: string,
    operationId: string,
  ): Promise<
    import("./core/preview-sessions.js").PreviewGrant & { url: string }
  > {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/preview-grants`,
      "POST",
      { exposureId, origin, operationId },
    );
  }
  previewGrantStatus(
    sandbox: string,
    id: string,
  ): Promise<import("./core/preview-sessions.js").PreviewSessionStatus> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/preview-grants/${identifier(id)}`,
    );
  }
  revokePreviewGrant(
    sandbox: string,
    id: string,
    operationId: string,
  ): Promise<Operation> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/preview-grants/${identifier(id)}`,
      "DELETE",
      { operationId },
    );
  }
  health(): Promise<import("./core/capabilities.js").ApiHealth> {
    return this.request("/v1/health");
  }
  capabilities(): Promise<import("./core/capabilities.js").ApiCapabilities> {
    return this.request("/v1/capabilities");
  }
  listSandboxes(): Promise<Sandbox[]> {
    return this.request("/v1/sandboxes");
  }
  getSandbox(id: string): Promise<Sandbox> {
    return this.request(`/v1/sandboxes/${identifier(id)}`);
  }
  createSandbox(
    id: string,
    image: string,
    operationId: string,
  ): Promise<Sandbox> {
    return this.request("/v1/sandboxes", "POST", {
      id: identifier(id),
      image,
      operationId: identifier(operationId),
    });
  }
  stopSandbox(
    id: string,
    operationId: string,
  ): ReturnType<SandboxManager["stop"]> {
    return this.request(`/v1/sandboxes/${identifier(id)}/stop`, "POST", {
      operationId: identifier(operationId),
    });
  }
  createCheckpoint(
    id: string,
    operationId: string,
  ): ReturnType<SandboxManager["stop"]> {
    return this.request(`/v1/sandboxes/${identifier(id)}/checkpoint`, "POST", {
      operationId: identifier(operationId),
    });
  }
  deleteSandbox(
    id: string,
    operationId: string,
  ): ReturnType<SandboxManager["deleteSandbox"]> {
    return this.request(`/v1/sandboxes/${identifier(id)}`, "DELETE", {
      operationId: identifier(operationId),
    });
  }
  startCommand(
    sandbox: string,
    id: string,
    argv: string[],
    cwd = "/workspace",
    timeout = 120,
  ): ReturnType<SandboxManager["startCommand"]> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/commands`,
      "POST",
      { id: identifier(id), argv, cwd, timeout },
    );
  }
  commandStatus(sandbox: string, id: string): Promise<Json> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/commands/${identifier(id)}`,
    );
  }
  commandOutput(
    sandbox: string,
    id: string,
    channel: "stdout" | "stderr",
    offset = 0,
    limit = OUTPUT_CHUNK,
  ): ReturnType<SandboxManager["commandOutput"]> {
    const query = new URLSearchParams({
      channel,
      offset: String(offset),
      bytes: String(limit),
    });
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/commands/${identifier(id)}/output?${query}`,
    );
  }
  streamStatus(
    sandbox: string,
    streamId: string,
  ): Promise<import("./core/streams.js").StreamStatus> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/streams/${identifier(streamId)}`,
    );
  }
  cancelStream(
    sandbox: string,
    streamId: string,
  ): Promise<import("./core/streams.js").StreamStatus> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/streams/${identifier(streamId)}`,
      "DELETE",
      {},
    );
  }
  exposePort(
    sandbox: string,
    operationId: string,
    port: number,
  ): Promise<Operation> {
    return this.request(`/v1/sandboxes/${identifier(sandbox)}/ports`, "POST", {
      operationId,
      port,
    });
  }
  portStatus(
    sandbox: string,
    exposureId: string,
  ): Promise<import("./core/ports.js").PortStatus> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/ports/${identifier(exposureId)}`,
    );
  }
  revokePort(
    sandbox: string,
    exposureId: string,
    operationId: string,
  ): Promise<Operation> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/ports/${identifier(exposureId)}`,
      "DELETE",
      { operationId },
    );
  }
  async request<T>(
    path: string,
    method = "GET",
    body?: Json,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (
      !path.startsWith("/v1/") ||
      path.split("?")[0]!.includes("..") ||
      path.includes("\\")
    )
      throw new Error("Invalid API path");
    const headers = {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
    };
    const options: RequestInit = { method, headers, redirect: "manual" };
    if (signal) options.signal = signal;
    if (body !== undefined) options.body = JSON.stringify(body);
    const response = await this.transport(new URL(path, this.base), options);
    if (!response.ok) {
      await response.body?.cancel();
      throw new JetskiHttpError(response.status);
    }
    return (await response.json()) as T;
  }
  startTerminal(
    sandbox: string,
    id: string,
    argv: string[],
    cwd = "/workspace",
    timeout = 120,
    geometry?: TerminalGeometry,
  ): Promise<Json> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/terminals`,
      "POST",
      { id, argv, cwd, timeout, ...terminalGeometry(geometry) },
    );
  }
  terminalInput(
    sandbox: string,
    terminal: string,
    id: string,
    input: TerminalInput,
    signal?: AbortSignal,
  ): Promise<Json> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/terminals/${identifier(terminal)}/inputs`,
      "POST",
      { id, input },
      signal,
    );
  }
  terminalInputStatus(
    sandbox: string,
    terminal: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<Json> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/terminals/${identifier(terminal)}/inputs/${identifier(id)}`,
      "GET",
      undefined,
      signal,
    );
  }
  terminalStatus(sandbox: string, terminal: string): Promise<Json> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/terminals/${identifier(terminal)}`,
    );
  }
  terminalOutput(
    sandbox: string,
    terminal: string,
    offset = 0,
    bytes = 65536,
    signal?: AbortSignal,
  ): Promise<{ base64: string; nextOffset: number; terminal: boolean }> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/terminals/${identifier(terminal)}/output?offset=${offset}&bytes=${bytes}`,
      "GET",
      undefined,
      signal,
    );
  }
  /** Pull-based output observation. Persist nextOffset after consuming a chunk
   * and pass it back on reconnect. Detaching never cancels remote execution. */
  async *followTerminal(
    sandbox: string,
    terminal: string,
    options: { offset?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<{
    bytes: Uint8Array;
    offset: number;
    nextOffset: number;
    terminal: boolean;
  }> {
    let offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > OUTPUT_LIMIT)
      throw Error("Invalid terminal output cursor");
    while (true) {
      options.signal?.throwIfAborted();
      const segment = await this.terminalOutput(
        sandbox,
        terminal,
        offset,
        OUTPUT_CHUNK,
        options.signal,
      );
      if (
        !segment ||
        typeof segment.base64 !== "string" ||
        typeof segment.terminal !== "boolean" ||
        !Number.isSafeInteger(segment.nextOffset)
      )
        throw Error("Invalid terminal output segment");
      const bytes = decodeBase64(segment.base64);
      if (
        segment.nextOffset !== offset + bytes.length ||
        segment.nextOffset > OUTPUT_LIMIT
      )
        throw Error("Terminal output cursor mismatch");
      if (bytes.length || segment.terminal) {
        yield {
          bytes,
          offset,
          nextOffset: segment.nextOffset,
          terminal: segment.terminal,
        };
        offset = segment.nextOffset;
      }
      if (segment.terminal) return;
      if (!bytes.length) await observationDelay(options.signal);
    }
  }
  async attachTerminal(
    state: StateStore,
    attachmentId: string,
    sandbox: string,
    terminal: string,
  ): Promise<TerminalAttachment> {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(this.base.origin + "\0" + this.token),
    );
    const binding = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return TerminalAttachment.open(
      state,
      attachmentId,
      { binding, sandbox, terminal },
      {
        observe: async (id, signal) => {
          try {
            return await this.terminalInputStatus(
              sandbox,
              terminal,
              id,
              signal,
            );
          } catch (error) {
            if (error instanceof JetskiHttpError && error.status === 404)
              return undefined;
            throw error;
          }
        },
        admit: (id, input, signal) =>
          this.terminalInput(sandbox, terminal, id, input, signal),
      },
    );
  }
  closeTerminal(sandbox: string, terminal: string): Promise<Json> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/terminals/${identifier(terminal)}/close`,
      "POST",
      {},
    );
  }
  cancelCommand(sandbox: string, command: string): Promise<Json> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/commands/${identifier(command)}/cancel`,
      "POST",
      {},
    );
  }
  readFile(
    sandbox: string,
    path: string,
    offset = 0,
    bytes = FILE_CHUNK_BYTES,
    version?: string,
  ): Promise<FileChunk> {
    const query = new URLSearchParams({
      path: persistentPath(path),
      offset: String(offset),
      bytes: String(bytes),
    });
    if (version) query.set("version", version);
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/files/read?${query}`,
    );
  }
  /** Incremental verified download. Mutating live files fail instead of mixing versions. */
  async *readFileStream(
    sandbox: string,
    path: string,
  ): AsyncIterable<Uint8Array> {
    yield* readFileChunks(this, sandbox, path);
  }
  listFiles(
    sandbox: string,
    path: string,
    after = "",
    limit = 256,
    version?: string,
  ): Promise<FileListing> {
    const query = new URLSearchParams({
      path: persistentPath(path),
      after,
      limit: String(limit),
    });
    if (version) query.set("version", version);
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/files/list?${query}`,
    );
  }
  beginUpload(
    sandbox: string,
    id: string,
    spec: UploadSpec,
  ): Promise<UploadStatus> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/files/uploads`,
      "POST",
      { id, ...spec },
    );
  }
  uploadStatus(sandbox: string, id: string): Promise<UploadStatus> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/files/uploads/${identifier(id)}`,
    );
  }
  async uploadChunk(
    sandbox: string,
    id: string,
    offset: number,
    data: Uint8Array,
  ): Promise<UploadStatus> {
    if (!data.length || data.length > FILE_CHUNK_BYTES)
      throw Error("Invalid upload chunk size");
    const sha256 = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new Uint8Array(data).buffer),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/files/uploads/${identifier(id)}`,
      "PUT",
      { offset, base64: encodeBase64(data), sha256 },
    );
  }
  finishUpload(sandbox: string, id: string): Promise<UploadStatus> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/files/uploads/${identifier(id)}/finish`,
      "POST",
      {},
    );
  }
  /** Source starts at byte zero on retry. Metadata binds it to the original content. */
  async writeFileStream(
    sandbox: string,
    id: string,
    spec: UploadSpec,
    source: AsyncIterable<Uint8Array>,
  ): Promise<UploadStatus> {
    return writeFileChunks(this, sandbox, id, spec, source);
  }
  /** Copy into a new stopped sandbox; explicitly resume after publication. */
  copyCheckpoint(
    id: string,
    image: string,
    operationId: string,
    sourceSandbox: string,
    checkpointId: string,
    content: CheckpointContent = "filesystem",
  ): Promise<import("./core/manager.js").Sandbox> {
    return this.request("/v1/sandboxes", "POST", {
      id,
      image,
      operationId,
      sourceSandbox,
      checkpointId,
      ...(checkpointContent(content) === "memory" ? { content } : {}),
    });
  }
  runtimeCapabilities(sandbox: string): Promise<SandboxRuntimeCapabilities> {
    return this.request(`/v1/sandboxes/${identifier(sandbox)}/capabilities`);
  }
  /** Quiesce and durably publish filesystem state before acknowledging RAM suspension. */
  suspend(
    sandbox: string,
    operationId: string,
    portable?: PortableMemoryOptions,
  ): Promise<Operation> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/suspend`,
      "POST",
      {
        operationId: identifier(operationId),
        ...(portable ? { portable: portableMemoryOptions(portable) } : {}),
      },
    );
  }
  /** Restore RAM when compatible, otherwise explicitly recover verified filesystem state. */
  resumeMemory(sandbox: string, operationId: string): Promise<Operation> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/resume-memory`,
      "POST",
      { operationId: identifier(operationId) },
    );
  }
  resume(sandbox: string, operationId: string, checkpointId?: string) {
    const body: { [key: string]: Json } = { operationId };
    if (checkpointId !== undefined)
      body.checkpointId = identifier(checkpointId);
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/resume`,
      "POST",
      body,
    );
  }
  recoverMissingPlacement(
    sandbox: string,
    operationId: string,
    recovery: MissingPlacementRecovery,
  ): Promise<Operation> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/recover-missing-placement`,
      "POST",
      {
        operationId: identifier(operationId),
        recovery: missingPlacementRecovery(recovery),
      },
    );
  }
  recoverMissingSource(
    sandbox: string,
    operationId: string,
    recovery: MissingSourceRecovery,
  ): Promise<Operation> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/recover-missing-source`,
      "POST",
      {
        operationId: identifier(operationId),
        recovery: missingSourceRecovery(recovery),
      },
    );
  }
  pendingOperations(
    sandbox: string,
    after = "",
    limit = 100,
  ): Promise<{ operations: Operation[]; next: string | null }> {
    const query = new URLSearchParams({ after, limit: String(limit) });
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/operations?${query}`,
    );
  }
  checkpoints(
    sandbox: string,
    after = "",
    limit = 100,
  ): Promise<CheckpointPage> {
    const query = new URLSearchParams({ after, limit: String(limit) });
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/checkpoints?${query}`,
    );
  }
  checkpoint(sandbox: string, id: string): Promise<CheckpointSummary> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/checkpoints/${identifier(id)}`,
    );
  }
  pinCheckpoint(
    sandbox: string,
    checkpoint: string,
    pin: string,
    retain: boolean,
    operationId: string,
  ): Promise<Operation> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/checkpoints/${identifier(checkpoint)}/pins`,
      "POST",
      { pin, retain, operationId },
    );
  }
  /** Resume observation of an existing operation. Never repeats its POST. */
  waitForOperation(
    sandbox: string,
    id: string,
    options: OperationWaitOptions = {},
  ): Promise<Operation> {
    identifier(sandbox);
    identifier(id);
    return observeOperation(
      sandbox,
      id,
      (signal) => this.operation(sandbox, id, signal),
      options,
    );
  }
  operation(
    sandbox: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<Operation> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/operations/${identifier(id)}`,
      "GET",
      undefined,
      signal,
    );
  }
}

/** Small server-backed facade; infrastructure stays on the configured controller. */
export class Jetski {
  constructor(private readonly options: JetskiOptions) {
    this.options = Object.freeze({ ...options });
    if (!options.token) throw Error("Jetski token required");
    // Validate the endpoint before any operation is admitted.
    new JetskiClient(options.url, options.token, options.fetch);
  }
  /** Original explicit SDK for terminals, previews, forwarding and advanced recovery. */
  get client() {
    return new JetskiClient(
      this.options.url,
      this.options.token,
      this.options.fetch,
    );
  }
  private clientFor(signal: AbortSignal) {
    return new JetskiClient(
      this.options.url,
      this.options.token,
      (input, init) =>
        (this.options.fetch ?? fetch)(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([signal, init.signal])
            : signal,
        }),
    );
  }
  async get(
    id: string,
    options: import("./client/sandbox.js").OperationOptions = {},
  ) {
    const info = await this.clientFor(
      sessionDeadline(options, this.options),
    ).getSandbox(id);
    return SandboxSession.attach(
      this.options,
      (signal) => this.clientFor(signal),
      info,
    );
  }
  list(options: import("./client/sandbox.js").OperationOptions = {}) {
    return this.clientFor(
      sessionDeadline(options, this.options),
    ).listSandboxes();
  }
  fromCheckpoint(options: FromCheckpointOptions) {
    return SandboxSession.fromCheckpoint(
      this.options,
      (signal) => this.clientFor(signal),
      options,
    );
  }
  async create(options: CreateOptions) {
    return sandboxSession(
      this.options,
      (signal) => this.clientFor(signal),
      options,
    );
  }
}
