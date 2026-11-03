import type { CapturedArchive } from "../core/archive-format.js";
import type { ArchiveSource } from "../core/archive-source.js";
import { MAX_CHECKPOINT_READ_BYTES } from "../core/archive-source.js";
import { decodeBase64 } from "../core/command-output.js";
import type { Json, StateStore } from "../core/contracts.js";
import { identifier } from "../core/contracts.js";
import type { HostLease } from "../core/pool.js";
import {
  type CachedResumeRequest,
  type CheckpointImportSink,
  HOST_CONTROL_TIMEOUT_MS,
  HOST_IMPORT_FILE_BYTES,
  HOST_PROTOCOL_VERSION,
  type HostRequest,
  type HostResponse,
  type HostTransport,
  HostTransportError,
  hostRequestByteLimit,
} from "../core/transport.js";
import type { BoatApi } from "../providers/boat.js";
import { BoatControlChannel } from "./boat-channel.js";
import {
  bindHostBackend,
  type HostBackend,
  hostControlArguments,
  PYTHON_HOST_BACKEND,
  validateHostBackend,
  verifyBackendStatus,
} from "./host-backend.js";

/** Fixed privileged control program; workload bytes enter only through stdin. */
export class BoatTransport implements HostTransport {
  async resumeCached(host: string, input: CachedResumeRequest): Promise<Json> {
    identifier(host);
    if (input.lease.machineId !== host)
      throw Error("Cached resume host mismatch");
    const { resources, ...checkpoint } = input;
    const supported = await this.state.transaction(
      (tx) => tx.get(`boat-cached-resume/${host}`) === 1,
    );
    if (!supported) return { ...checkpoint, ready: false, runtime: null };
    return (
      await this.request(host, {
        version: HOST_PROTOCOL_VERSION,
        id: crypto.randomUUID(),
        action: "resume-cached",
        payload: { ...checkpoint, ...resources },
      })
    ).result;
  }
  private readonly channel: BoatControlChannel;
  private readonly backend: HostBackend;
  readonly checkpointImport?: (
    host: string,
    lease: HostLease,
    image: string,
  ) => Promise<CheckpointImportSink>;
  readonly checkpointSource?: (
    host: string,
    lease: HostLease,
    archive: CapturedArchive,
    image: string,
  ) => Promise<ArchiveSource | undefined>;
  constructor(
    private readonly state: StateStore,
    private readonly api: BoatApi,
    timeoutSeconds = HOST_CONTROL_TIMEOUT_MS / 1000,
    options: {
      archiveReads?: boolean;
      archiveWrites?: boolean;
      backend?: HostBackend;
    } = {},
  ) {
    this.backend = structuredClone(options.backend ?? PYTHON_HOST_BACKEND);
    validateHostBackend(this.backend);
    this.channel = new BoatControlChannel(
      state,
      api,
      timeoutSeconds,
      this.backend.kind === "rust" ? this.backend.sha256 : undefined,
    );
    if (
      options.archiveReads !== undefined &&
      typeof options.archiveReads !== "boolean"
    )
      throw Error("Invalid binary archive read policy");
    if (
      options.archiveWrites !== undefined &&
      typeof options.archiveWrites !== "boolean"
    )
      throw Error("Invalid binary archive write policy");
    if (options.archiveWrites)
      this.checkpointImport = (host, lease, image) =>
        this.openImport(host, lease, image);
    if (options.archiveReads)
      this.checkpointSource = (host, lease, archive, image) =>
        this.openCheckpoint(host, lease, archive, image);
  }
  private async openImport(
    host: string,
    lease: HostLease,
    image: string,
  ): Promise<CheckpointImportSink> {
    identifier(lease.assignmentId);
    const request = async (
      action: string,
      payload: Record<string, Json> = {},
    ) =>
      (
        await this.request(host, {
          version: HOST_PROTOCOL_VERSION,
          id: crypto.randomUUID(),
          action,
          payload: { ...payload, lease, image },
        })
      ).result;
    const value = await request("import-file-begin");
    const path = `/tmp/jetski-checkpoint-imports/${lease.assignmentId}/chunk.bin`;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.path !== path ||
      value.chunkBytes !== HOST_IMPORT_FILE_BYTES
    )
      throw Error("Invalid binary import negotiation");
    return {
      chunkBytes: HOST_IMPORT_FILE_BYTES,
      write: async (offset, bytes, sha256) => {
        await this.api.uploadCheckpointPart(host, path, bytes);
        return request("import-file-chunk", {
          offset,
          bytes: bytes.length,
          sha256,
        });
      },
      close: async () => {
        const done = await request("import-file-close");
        if (
          !done ||
          typeof done !== "object" ||
          Array.isArray(done) ||
          done.closed !== true
        )
          throw Error("Binary import cleanup unconfirmed");
      },
    };
  }
  private async openCheckpoint(
    host: string,
    lease: HostLease,
    archive: CapturedArchive,
    image: string,
  ): Promise<ArchiveSource> {
    identifier(lease.assignmentId);
    let prepared = false;
    let opening:
      | Promise<Awaited<ReturnType<BoatApi["openDownload"]>> | undefined>
      | undefined;
    const open = async () => {
      const value = (
        await this.request(host, {
          version: HOST_PROTOCOL_VERSION,
          id: crypto.randomUUID(),
          action: "checkpoint-source",
          payload: {
            lease,
            image,
            sha256: archive.sha256,
            bytes: archive.bytes,
          },
        })
      ).result;
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        value.supported === false
      )
        return undefined;
      const path = `/tmp/jetski-checkpoint-exports/${lease.assignmentId}/archive.tgz`;
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        value.path !== path ||
        value.sha256 !== archive.sha256 ||
        value.bytes !== archive.bytes
      )
        throw Error("Checkpoint source identity mismatch");
      prepared = true;
      return this.api.openDownload(host, path, archive.bytes, {
        sequential: true,
      });
    };
    return {
      // Preserve contiguous stream order across physical packs.
      readConcurrency: 1,
      readChunkBytes: MAX_CHECKPOINT_READ_BYTES,
      read: async (offset, bytes) => {
        // Small changed members avoid setup round trips. Large sequential reads
        // share one authorization; no handles are opened for a fully reused save.
        if (bytes >= 512 * 1024 || opening) {
          opening ??= open();
          const binary = await opening;
          if (binary) return binary.read(offset, bytes);
        }
        const value = (
          await this.request(host, {
            version: HOST_PROTOCOL_VERSION,
            id: crypto.randomUUID(),
            action: "read-checkpoint",
            payload: { lease, image, offset, bytes },
          })
        ).result;
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          value.offset !== offset ||
          value.bytes !== bytes ||
          typeof value.base64 !== "string"
        )
          throw Error("Invalid checkpoint source range");
        return decodeBase64(value.base64, bytes);
      },
      close: async () => {
        const binary = await opening?.catch(() => undefined);
        await binary?.close();
        if (!prepared) return;
        const done = (
          await this.request(host, {
            version: HOST_PROTOCOL_VERSION,
            id: crypto.randomUUID(),
            action: "checkpoint-source-close",
            payload: { lease, image },
          })
        ).result;
        if (
          !done ||
          typeof done !== "object" ||
          Array.isArray(done) ||
          done.closed !== true
        )
          throw Error("Checkpoint source cleanup unconfirmed");
      },
    };
  }
  async request(
    host: string,
    request: HostRequest,
    signal?: AbortSignal,
  ): Promise<HostResponse> {
    identifier(request.id);
    identifier(request.action);
    if (request.version !== HOST_PROTOCOL_VERSION)
      throw Error("Unsupported host protocol");
    await bindHostBackend(this.state, host, this.backend);
    const stdout = await this.channel.run(
      host,
      Buffer.from(JSON.stringify(request)),
      ["sudo", "-n", ...hostControlArguments(this.backend)],
      signal,
      hostRequestByteLimit(request.action),
    );
    try {
      const response = JSON.parse(stdout) as HostResponse;
      if (
        !response ||
        response.version !== HOST_PROTOCOL_VERSION ||
        response.id !== request.id ||
        !Object.hasOwn(response, "result")
      )
        throw Error("Invalid host response");
      if (request.action === "status") {
        verifyBackendStatus(this.backend, response.result);
        const proof = response.result;
        const supported =
          proof &&
          typeof proof === "object" &&
          !Array.isArray(proof) &&
          proof.ready === true &&
          proof.machineId === host &&
          proof.cachedResumeVersion === 1;
        await this.state.transaction((tx) =>
          tx.put(`boat-cached-resume/${host}`, supported ? 1 : 0),
        );
      }
      return response;
    } catch {
      throw new HostTransportError(
        "Boat host control failed; remote completion unknown",
      );
    }
  }
}
