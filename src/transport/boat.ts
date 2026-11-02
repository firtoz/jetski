import type { CapturedArchive } from "../core/archive-format.js";
import type { ArchiveSource } from "../core/archive-source.js";
import { MAX_CHECKPOINT_READ_BYTES } from "../core/archive-source.js";
import { decodeBase64 } from "../core/command-output.js";
import type { StateStore } from "../core/contracts.js";
import { identifier } from "../core/contracts.js";
import type { HostLease } from "../core/pool.js";
import {
  HOST_CONTROL_TIMEOUT_MS,
  HOST_PROTOCOL_VERSION,
  type HostRequest,
  type HostResponse,
  type HostTransport,
  HostTransportError,
  hostRequestByteLimit,
} from "../core/transport.js";
import type { BoatApi } from "../providers/boat.js";
import { BoatControlChannel } from "./boat-channel.js";

/** Fixed privileged control program; workload bytes enter only through stdin. */
export class BoatTransport implements HostTransport {
  private readonly channel: BoatControlChannel;
  readonly checkpointSource?: (
    host: string,
    lease: HostLease,
    archive: CapturedArchive,
    image: string,
  ) => Promise<ArchiveSource | undefined>;
  constructor(
    state: StateStore,
    private readonly api: BoatApi,
    timeoutSeconds = HOST_CONTROL_TIMEOUT_MS / 1000,
    options: { archiveReads?: boolean } = {},
  ) {
    this.channel = new BoatControlChannel(state, api, timeoutSeconds);
    if (
      options.archiveReads !== undefined &&
      typeof options.archiveReads !== "boolean"
    )
      throw Error("Invalid binary archive read policy");
    if (options.archiveReads)
      this.checkpointSource = (host, lease, archive, image) =>
        this.openCheckpoint(host, lease, archive, image);
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
      readConcurrency: 4,
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
    const stdout = await this.channel.run(
      host,
      Buffer.from(JSON.stringify(request)),
      [
        "sudo",
        "-n",
        "env",
        "-i",
        "PATH=/usr/bin:/bin",
        "python3",
        "-I",
        "/opt/jetski/host/control.py",
      ],
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
      return response;
    } catch {
      throw new HostTransportError(
        "Boat host control failed; remote completion unknown",
      );
    }
  }
}
