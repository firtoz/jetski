import {
  decodeBase64,
  OUTPUT_CHUNK,
  OUTPUT_LIMIT,
} from "../core/command-output.js";
import type { Sandbox } from "../core/manager.js";
import { MAX_FILE_UPLOAD_BYTES } from "../core/uploads.js";
import type { JetskiClient } from "../sdk.js";
import {
  OPERATION_WAIT_LIMITS,
  observationDelay,
  observeOperation,
} from "./wait.js";

export type SandboxApi = Pick<
  JetskiClient,
  | "createSandbox"
  | "copyCheckpoint"
  | "operation"
  | "getSandbox"
  | "startCommand"
  | "commandStatus"
  | "commandOutput"
  | "stopSandbox"
  | "readFile"
  | "readFileStream"
  | "listFiles"
  | "writeFileStream"
  | "beginUpload"
  | "uploadStatus"
  | "uploadChunk"
  | "finishUpload"
  | "resume"
  | "createCheckpoint"
  | "checkpoint"
  | "checkpoints"
  | "deleteSandbox"
  | "pinCheckpoint"
  | "exposePort"
  | "portStatus"
  | "revokePort"
  | "listSandboxes"
  | "runtimeCapabilities"
  | "suspend"
  | "resumeMemory"
  | "startTerminal"
  | "terminalInput"
  | "terminalInputStatus"
  | "terminalStatus"
  | "terminalOutput"
  | "closeTerminal"
  | "cancelCommand"
>;

export type SandboxOperation = Readonly<{
  kind:
    | "create"
    | "copy"
    | "exec"
    | "stop"
    | "write"
    | "checkpoint"
    | "resume"
    | "delete"
    | "expose"
    | "revoke"
    | "pin";
  sandboxId: string;
  operationId: string;
}>;
export type SessionOptions = {
  /** Bounds observation, not the lifetime of remote work. */
  waitTimeoutMs?: number;
  /** Called before a mutating request; applications can persist IDs here. */
  onOperation?: (operation: SandboxOperation) => void | Promise<void>;
};
export type JetskiOptions = SessionOptions & {
  url: string;
  token: string;
  fetch?: typeof fetch;
};
export type OperationOptions = {
  operationId?: string;
  signal?: AbortSignal;
  waitTimeoutMs?: number;
};
export type CreateOptions = OperationOptions & { id?: string; image: string };
export type FromCheckpointOptions = OperationOptions & {
  id?: string;
  sourceSandboxId: string;
  checkpointId: string;
  image?: string;
};
export type ExecOptions = Omit<OperationOptions, "operationId"> & {
  id?: string;
  cwd?: string;
  timeoutSeconds?: number;
  check?: boolean;
};
export class JetskiOperationError extends Error {
  constructor(
    readonly operation: SandboxOperation,
    cause: unknown,
  ) {
    super(
      `${operation.kind} did not complete: sandbox=${operation.sandboxId}, operation=${operation.operationId}. Observe these IDs before retrying.`,
      { cause },
    );
    this.name = "JetskiOperationError";
  }
}

export function sessionDeadline(
  options: OperationOptions,
  defaults: SessionOptions,
): AbortSignal {
  const ms =
    options.waitTimeoutMs ??
    defaults.waitTimeoutMs ??
    OPERATION_WAIT_LIMITS.defaultMs;
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > OPERATION_WAIT_LIMITS.maxMs)
    throw Error("Invalid observation timeout");
  const timeout = AbortSignal.timeout(ms);
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid observation");
  return value as Record<string, unknown>;
}
async function completedOperation(
  client: SandboxApi,
  operation: SandboxOperation,
  signal: AbortSignal,
) {
  while (true) {
    signal.throwIfAborted();
    const result = await client.operation(
      operation.sandboxId,
      operation.operationId,
    );
    if (result.phase === "succeeded") return;
    if (result.phase !== "queued" && result.phase !== "running")
      throw Error(`Operation is ${result.phase}`);
    await observationDelay(signal);
  }
}
async function output(
  client: SandboxApi,
  sandbox: string,
  command: string,
  channel: "stdout" | "stderr",
  signal: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (true) {
    signal.throwIfAborted();
    const segment = record(
      await client.commandOutput(
        sandbox,
        command,
        channel,
        offset,
        OUTPUT_CHUNK,
      ),
    );
    if (
      typeof segment.base64 !== "string" ||
      typeof segment.terminal !== "boolean" ||
      !Number.isSafeInteger(segment.nextOffset)
    )
      throw Error("Invalid output segment");
    const bytes = decodeBase64(segment.base64);
    if (
      segment.nextOffset !== offset + bytes.length ||
      (segment.nextOffset as number) > OUTPUT_LIMIT
    )
      throw Error("Output cursor mismatch");
    if (bytes.length) chunks.push(bytes);
    offset = segment.nextOffset as number;
    if (segment.terminal) break;
    if (!bytes.length) await observationDelay(signal);
  }
  const result = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) {
    result.set(chunk, at);
    at += chunk.length;
  }
  return result;
}
export type CommandResult = {
  id: string;
  exitCode: number;
  stdoutBytes: Uint8Array;
  stderrBytes: Uint8Array;
  /** Strict UTF-8 view. Binary output stays available as bytes. */
  readonly stdout: string;
  readonly stderr: string;
};

/** Convenience observations over the existing API. Never retries a mutation or
 * schedules server work. A detached/timed-out request may still be running. */
export class SandboxSession {
  private stopId: string | undefined;
  private stopGeneration: number | undefined;
  private constructor(
    readonly id: string,
    readonly createOperationId: string,
    private readonly options: SessionOptions,
    private readonly clientFor: (signal: AbortSignal) => SandboxApi,
  ) {}
  static attach(
    options: SessionOptions,
    clientFor: (signal: AbortSignal) => SandboxApi,
    info: Sandbox,
  ) {
    return new SandboxSession(
      info.id,
      info.createOperation,
      options,
      clientFor,
    );
  }
  /** Explicit low-level IDs/cursors for advanced examples. No mutations are retried. */
  raw(options: OperationOptions = {}): SandboxApi {
    return this.clientFor(sessionDeadline(options, this.options));
  }
  /** Reconnect to an existing operation ID without admitting another operation. */
  waitForOperation(
    id: string,
    options: Omit<OperationOptions, "operationId"> = {},
  ) {
    const signal = sessionDeadline(options, this.options);
    const client = this.clientFor(signal);
    return observeOperation(this.id, id, () => client.operation(this.id, id), {
      signal,
    });
  }
  inspect(options: OperationOptions = {}) {
    return this.raw(options).getSandbox(this.id);
  }
  readFileStream(path: string, options: OperationOptions = {}) {
    return this.raw(options).readFileStream(this.id, path);
  }
  async readFile(
    path: string,
    options: OperationOptions & { maxBytes?: number } = {},
  ): Promise<Uint8Array> {
    const max = options.maxBytes ?? OUTPUT_LIMIT;
    if (!Number.isSafeInteger(max) || max < 0 || max > MAX_FILE_UPLOAD_BYTES)
      throw Error("Invalid read bound; use readFileStream for large files");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of this.readFileStream(path, options)) {
      size += chunk.length;
      if (size > max)
        throw Error("File exceeds read bound; use readFileStream");
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
  async readText(
    path: string,
    options: OperationOptions & { maxBytes?: number } = {},
  ) {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await this.readFile(path, options),
    );
  }
  listFiles(
    path = "/workspace",
    options: OperationOptions & {
      after?: string;
      limit?: number;
      version?: string;
    } = {},
  ) {
    return this.raw(options).listFiles(
      this.id,
      path,
      options.after ?? "",
      options.limit ?? 256,
      options.version,
    );
  }
  async writeFile(
    path: string,
    contents: string | Uint8Array,
    options: OperationOptions & { mode?: number } = {},
  ) {
    const bytes =
      typeof contents === "string"
        ? new TextEncoder().encode(contents)
        : new Uint8Array(contents);
    if (bytes.length > MAX_FILE_UPLOAD_BYTES)
      throw Error("File exceeds upload bound");
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (n) => n.toString(16).padStart(2, "0"),
    ).join("");
    const operation = {
      kind: "write",
      sandboxId: this.id,
      operationId: options.operationId ?? crypto.randomUUID(),
    } as const;
    return this.run(operation, options, async (client) => {
      const result = await client.writeFileStream(
        this.id,
        operation.operationId,
        {
          path,
          bytes: bytes.length,
          sha256: hash,
          mode: options.mode ?? 0o644,
        },
        (async function* () {
          yield bytes;
        })(),
      );
      if (result.phase !== "committed")
        throw Error(`Upload is ${result.phase}`);
      return result;
    });
  }
  async checkpoint(options: OperationOptions & { releaseHost?: boolean } = {}) {
    const operation = {
      kind: "checkpoint",
      sandboxId: this.id,
      operationId: options.operationId ?? crypto.randomUUID(),
    } as const;
    return this.run(operation, options, async (client, signal) => {
      if (options.releaseHost)
        await client.stopSandbox(this.id, operation.operationId);
      else await client.createCheckpoint(this.id, operation.operationId);
      await completedOperation(client, operation, signal);
      const info = await client.getSandbox(this.id);
      if (!info.checkpoint || info.phase !== "stopped")
        throw Error("Checkpoint is not stopped/published");
      if (options.releaseHost && (info.lease || info.pendingResume))
        throw Error("Checkpoint assignment is not released");
      return client.checkpoint(this.id, info.checkpoint);
    });
  }
  async resume(options: OperationOptions & { checkpointId?: string } = {}) {
    const operation = {
      kind: "resume",
      sandboxId: this.id,
      operationId: options.operationId ?? crypto.randomUUID(),
    } as const;
    await this.run(operation, options, async (client, signal) => {
      await client.resume(this.id, operation.operationId, options.checkpointId);
      await completedOperation(client, operation, signal);
      if ((await client.getSandbox(this.id)).phase !== "running")
        throw Error("Resume is not ready");
      this.stopId = undefined;
      this.stopGeneration = undefined;
    });
    return this;
  }
  checkpoints(
    options: OperationOptions & { after?: string; limit?: number } = {},
  ) {
    return this.raw(options).checkpoints(this.id, options.after, options.limit);
  }
  async pin(
    checkpointId: string,
    name: string,
    retain = true,
    options: OperationOptions = {},
  ) {
    const operation = {
      kind: "pin",
      sandboxId: this.id,
      operationId: options.operationId ?? crypto.randomUUID(),
    } as const;
    return this.run(operation, options, async (client, signal) => {
      await client.pinCheckpoint(
        this.id,
        checkpointId,
        name,
        retain,
        operation.operationId,
      );
      await completedOperation(client, operation, signal);
    });
  }
  async exposePort(port: number, options: OperationOptions = {}) {
    const operation = {
      kind: "expose",
      sandboxId: this.id,
      operationId: options.operationId ?? crypto.randomUUID(),
    } as const;
    return this.run(operation, options, async (client, signal) => {
      await client.exposePort(this.id, operation.operationId, port);
      await completedOperation(client, operation, signal);
      return client.portStatus(this.id, operation.operationId);
    });
  }
  async revokePort(exposureId: string, options: OperationOptions = {}) {
    const operation = {
      kind: "revoke",
      sandboxId: this.id,
      operationId: options.operationId ?? crypto.randomUUID(),
    } as const;
    return this.run(operation, options, async (client, signal) => {
      await client.revokePort(this.id, exposureId, operation.operationId);
      await completedOperation(client, operation, signal);
    });
  }
  async delete(options: OperationOptions = {}) {
    const operation = {
      kind: "delete",
      sandboxId: this.id,
      operationId: options.operationId ?? crypto.randomUUID(),
    } as const;
    return this.run(operation, options, async (client, signal) => {
      await client.deleteSandbox(this.id, operation.operationId);
      await completedOperation(client, operation, signal);
    });
  }
  /** Copy a retained filesystem checkpoint into a distinct stopped sandbox.
   * Publication and resume are separate operations with separate recovery IDs. */
  static async fromCheckpoint(
    options: SessionOptions,
    clientFor: (signal: AbortSignal) => SandboxApi,
    input: FromCheckpointOptions,
  ) {
    const session = new SandboxSession(
      input.id ?? crypto.randomUUID(),
      input.operationId ?? crypto.randomUUID(),
      options,
      clientFor,
    );
    const operation = {
      kind: "copy",
      sandboxId: session.id,
      operationId: session.createOperationId,
    } as const;
    await session.run(operation, input, async (client, signal) => {
      const image =
        input.image ?? (await client.getSandbox(input.sourceSandboxId)).image;
      await client.copyCheckpoint(
        session.id,
        image,
        operation.operationId,
        input.sourceSandboxId,
        input.checkpointId,
      );
      await completedOperation(client, operation, signal);
      const info = await client.getSandbox(session.id);
      if (
        info.phase !== "stopped" ||
        !info.checkpoint ||
        info.lease ||
        info.pendingResume
      )
        throw Error("Copied checkpoint is not published/stopped");
    });
    return session;
  }
  static async create(
    options: SessionOptions,
    clientFor: (signal: AbortSignal) => SandboxApi,
    create: CreateOptions,
  ) {
    const session = new SandboxSession(
      create.id ?? crypto.randomUUID(),
      create.operationId ?? crypto.randomUUID(),
      options,
      clientFor,
    );
    await session.ready(create.image, create);
    return session;
  }
  private async run<T>(
    input:
      | SandboxOperation
      | ((client: SandboxApi) => Promise<SandboxOperation>),
    options: OperationOptions,
    execute: (
      client: SandboxApi,
      signal: AbortSignal,
      operation: SandboxOperation,
    ) => Promise<T>,
  ): Promise<T> {
    let operation = typeof input === "function" ? undefined : input;
    try {
      const signal = sessionDeadline(options, this.options);
      signal.throwIfAborted();
      const client = this.clientFor(signal);
      operation ??= await (
        input as (client: SandboxApi) => Promise<SandboxOperation>
      )(client);
      const before = this.options.onOperation?.(
        Object.freeze({ ...operation }),
      );
      if (before)
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          Promise.resolve(before)
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", abort));
          if (signal.aborted) abort();
        });
      signal.throwIfAborted();
      return await execute(client, signal, operation);
    } catch (cause) {
      if (!operation) throw cause;
      throw new JetskiOperationError(operation, cause);
    }
  }
  private async ready(
    image: string,
    options: OperationOptions = {},
  ): Promise<void> {
    const operation = {
      kind: "create",
      sandboxId: this.id,
      operationId: this.createOperationId,
    } as const;
    await this.run(operation, options, async (client, signal) => {
      await client.createSandbox(this.id, image, this.createOperationId);
      await completedOperation(client, operation, signal);
      if ((await client.getSandbox(this.id)).phase !== "running")
        throw Error("Sandbox is not running");
    });
  }
  async exec(
    argv: string[],
    options: ExecOptions = {},
  ): Promise<CommandResult> {
    const id = options.id ?? crypto.randomUUID();
    const operation = {
      kind: "exec",
      sandboxId: this.id,
      operationId: id,
    } as const;
    return this.run(operation, options, async (client, signal) => {
      await client.startCommand(
        this.id,
        id,
        argv,
        options.cwd ?? "/workspace",
        options.timeoutSeconds ?? 120,
      );
      let status: Record<string, unknown>;
      while (true) {
        signal.throwIfAborted();
        status = record(await client.commandStatus(this.id, id));
        if (status.phase === "succeeded" || status.phase === "failed") break;
        if (status.phase !== "running" && status.phase !== "queued")
          throw Error(`Command is ${status.phase}`);
        await observationDelay(signal);
      }
      if (!Number.isSafeInteger(status.exitCode))
        throw Error("Command has no confirmed exit code");
      // Sequential channels share one deadline and bounded retained-output limits.
      const stdoutBytes = await output(client, this.id, id, "stdout", signal);
      const stderrBytes = await output(client, this.id, id, "stderr", signal);
      const result: CommandResult = {
        id,
        exitCode: status.exitCode as number,
        stdoutBytes,
        stderrBytes,
        get stdout() {
          return new TextDecoder("utf-8", { fatal: true }).decode(stdoutBytes);
        },
        get stderr() {
          return new TextDecoder("utf-8", { fatal: true }).decode(stderrBytes);
        },
      };
      if (result.exitCode !== 0 && options.check !== false)
        throw new JetskiCommandError(result);
      return result;
    });
  }
  async stop(options: OperationOptions = {}): Promise<void> {
    let generation: number;
    await this.run(
      async (client) => {
        const info = await client.getSandbox(this.id);
        generation = info.generation;
        if (!Number.isSafeInteger(generation) || generation < 1)
          throw Error("Invalid sandbox generation");
        if (this.stopGeneration !== generation) {
          this.stopId = undefined;
          this.stopGeneration = generation;
        }
        if (
          this.stopId &&
          options.operationId &&
          options.operationId !== this.stopId
        )
          throw Error("Stop identity is already fixed");
        this.stopId ??= options.operationId ?? crypto.randomUUID();
        return { kind: "stop", sandboxId: this.id, operationId: this.stopId };
      },
      options,
      async (client, signal, operation) => {
        await client.stopSandbox(this.id, operation.operationId);
        await completedOperation(client, operation, signal);
        const info = await client.getSandbox(this.id);
        if (
          info.generation !== generation ||
          info.phase !== "stopped" ||
          info.lease ||
          info.pendingResume
        )
          throw Error("Sandbox is not released at the stopped generation");
      },
    );
  }
}

export function sandboxSession(
  options: SessionOptions,
  clientFor: (signal: AbortSignal) => SandboxApi,
  create: CreateOptions,
) {
  return SandboxSession.create(options, clientFor, create);
}

export class JetskiCommandError extends Error {
  constructor(readonly result: CommandResult) {
    super(`Command exited with status ${result.exitCode}`);
    this.name = "JetskiCommandError";
  }
}
