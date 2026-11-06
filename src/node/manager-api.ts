import { readFileChunks, writeFileChunks } from "../client/files.js";
import type { SandboxApi } from "../client/sandbox.js";
import { encodeBase64, OUTPUT_CHUNK } from "../core/command-output.js";
import { identifier } from "../core/contracts.js";
import {
  FILE_CHUNK_BYTES,
  type FileChunk,
  type FileListing,
} from "../core/files.js";
import type { SandboxManager } from "../core/manager.js";

/** Direct owner-scoped calls. No listener, loopback HTTP, bearer token or router. */
export function managerApi(
  manager: SandboxManager,
  owner: string,
  invoke: <T>(body: () => Promise<T>, signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): SandboxApi {
  const scope = (id: string) => ({ owner, sandbox: identifier(id) });
  const call = <T>(body: () => Promise<T>, extra?: AbortSignal) =>
    invoke(
      body,
      extra && signal ? AbortSignal.any([signal, extra]) : (extra ?? signal),
    );
  const api: SandboxApi = {
    copyCheckpoint: (id, image, operation, source, checkpoint, content) =>
      call(() =>
        manager.copyCheckpoint(
          owner,
          id,
          image,
          operation,
          source,
          checkpoint,
          content,
        ),
      ),
    createSandbox: (id, image, operation) =>
      call(() => manager.create(owner, id, image, operation)),
    getSandbox: (id) =>
      call(async () => {
        const value = await manager.get(scope(id));
        if (!value) throw Error("Sandbox unavailable");
        return value;
      }),
    listSandboxes: () => call(() => manager.list(owner)),
    operation: (id, operation) =>
      call(async () => {
        const value = await manager.operation(scope(id), operation);
        if (!value) throw Error("Operation unavailable");
        return value;
      }),
    stopSandbox: (id, operation) =>
      call(() => manager.stop(scope(id), operation)),
    createCheckpoint: (id, operation) =>
      call(() => manager.stop(scope(id), operation, "checkpoint")),
    resume: (id, operation, checkpoint) =>
      call(() => manager.resume(scope(id), operation, checkpoint)),
    deleteSandbox: (id, operation) =>
      call(() => manager.deleteSandbox(scope(id), operation)),
    startCommand: (id, command, argv, cwd, timeout) =>
      call(() => manager.startCommand(scope(id), command, argv, cwd, timeout)),
    commandStatus: (id, command) =>
      call(() => manager.commandStatus(scope(id), command)),
    commandOutput: (id, command, channel, offset, bytes) =>
      call(() =>
        manager.commandOutput(
          scope(id),
          command,
          channel,
          offset ?? 0,
          bytes ?? OUTPUT_CHUNK,
        ),
      ),
    cancelCommand: (id, command) =>
      call(() => manager.cancelCommand(scope(id), command)),
    readFile: (id, path, offset, bytes, version) =>
      call(
        async () =>
          (await manager.readFile(
            scope(id),
            path,
            offset,
            bytes,
            version,
          )) as unknown as FileChunk,
      ),
    readFileStream: (id, path) => readFileChunks(api, id, path),
    listFiles: (id, path, after, limit, version) =>
      call(
        async () =>
          (await manager.listFiles(
            scope(id),
            path,
            after,
            limit,
            version,
          )) as unknown as FileListing,
      ),
    beginUpload: (id, upload, spec) =>
      call(() => manager.uploads.begin(scope(id), upload, spec)),
    uploadStatus: (id, upload) =>
      call(() => manager.uploads.status(scope(id), upload)),
    uploadChunk: (id, upload, offset, bytes) =>
      call(async () => {
        if (!bytes.length || bytes.length > FILE_CHUNK_BYTES)
          throw Error("Invalid upload chunk size");
        const digest = Array.from(
          new Uint8Array(
            await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
          ),
          (n) => n.toString(16).padStart(2, "0"),
        ).join("");
        return manager.uploads.chunk(
          scope(id),
          upload,
          offset,
          encodeBase64(bytes),
          digest,
        );
      }),
    finishUpload: (id, upload) =>
      call(() => manager.uploads.finish(scope(id), upload)),
    writeFileStream: (id, upload, spec, source) =>
      writeFileChunks(api, id, upload, spec, source),
    checkpoints: (id, after, limit) =>
      call(() => manager.history.list(scope(id), after, limit)),
    checkpoint: (id, checkpoint) =>
      call(async () => {
        const value = await manager.history.get(scope(id), checkpoint);
        if (!value) throw Error("Checkpoint unavailable");
        return value;
      }),
    pinCheckpoint: (id, checkpoint, pin, retain, operation) =>
      call(() =>
        manager.history.pin(scope(id), checkpoint, pin, retain, operation),
      ),
    exposePort: (id, operation, port) =>
      call(() => manager.ports.expose(scope(id), operation, port)),
    portStatus: (id, exposure) =>
      call(() => manager.ports.status(scope(id), exposure)),
    revokePort: (id, exposure, operation) =>
      call(() => manager.ports.revoke(scope(id), exposure, operation)),
    runtimeCapabilities: (id) =>
      call(() => manager.runtimeCapabilities(scope(id))),
    suspend: (id, operation, portable) =>
      call(async () => {
        const value = await manager.suspend(scope(id), operation, portable);
        if (!value) throw Error("Operation unavailable");
        return value;
      }),
    resumeMemory: (id, operation) =>
      call(async () => {
        const value = await manager.resumeMemory(scope(id), operation);
        if (!value) throw Error("Operation unavailable");
        return value;
      }),
    startTerminal: (id, terminal, argv, cwd, timeout, geometry) =>
      call(() =>
        manager.startTerminal(
          scope(id),
          terminal,
          argv,
          cwd,
          timeout,
          geometry,
        ),
      ),
    terminalStatus: (id, terminal) =>
      call(async () => {
        await manager.requireTerminal(scope(id), terminal);
        return manager.commandStatus(scope(id), terminal);
      }),
    terminalInput: (id, terminal, input, body, abort) =>
      call(
        () => manager.terminalInput(scope(id), terminal, input, body),
        abort,
      ),
    terminalInputStatus: (id, terminal, input, abort) =>
      call(
        () => manager.terminalInputStatus(scope(id), terminal, input),
        abort,
      ),
    terminalOutput: (id, terminal, offset, bytes, abort) =>
      call(async () => {
        await manager.requireTerminal(scope(id), terminal);
        return (await manager.commandOutput(
          scope(id),
          terminal,
          "stdout",
          offset ?? 0,
          bytes ?? FILE_CHUNK_BYTES,
        )) as { base64: string; nextOffset: number; terminal: boolean };
      }, abort),
    closeTerminal: (id, terminal) =>
      call(async () => {
        await manager.requireTerminal(scope(id), terminal);
        return manager.cancelCommand(scope(id), terminal);
      }),
  };
  return api;
}
