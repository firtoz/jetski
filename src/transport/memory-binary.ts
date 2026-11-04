import type { ArchiveSource } from "../core/archive-source.js";
import { MAX_CHECKPOINT_READ_BYTES } from "../core/archive-source.js";
import { decodeBase64 } from "../core/command-output.js";
import { identifier, type Json } from "../core/contracts.js";
import type { CapturedMemory } from "../core/memory-capture.js";
import type { HostLease } from "../core/pool.js";
import {
  HOST_IMPORT_CHUNK_BYTES,
  type MemoryImportSink,
} from "../core/transport.js";
import type { BoatApi } from "../providers/boat.js";

type Request = (action: string, payload: Record<string, Json>) => Promise<Json>;
const record = (value: Json): value is Record<string, Json> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const prefix = (lease: HostLease, id: string) => {
  identifier(lease.assignmentId);
  identifier(id);
  if (!Number.isSafeInteger(lease.generation) || lease.generation < 1)
    throw Error("Invalid memory transfer generation");
  return `${lease.assignmentId}-g${lease.generation}/${id}`;
};
/** Transport-only binary bindings. Core verifies stored/decoded objects and the
 * native importer still owns offsets, compatibility, fencing and execution. */
export function boatMemorySource(
  api: BoatApi,
  host: string,
  lease: HostLease,
  id: string,
  capture: CapturedMemory,
  request: Request,
): ArchiveSource {
  const path = `/tmp/jetski-memory-exports/${prefix(lease, id)}/memory.pack`;
  let opening:
    | Promise<Awaited<ReturnType<BoatApi["openDownload"]>> | undefined>
    | undefined;
  let closed = false;
  return {
    readConcurrency: 1,
    readChunkBytes: MAX_CHECKPOINT_READ_BYTES,
    async read(offset, bytes) {
      if (closed) throw Error("Memory source closed");
      opening ??= (async () => {
        const v = await request("memory-source", {
          checkpointId: id,
          sha256: capture.sha256,
          bytes: capture.bytes,
        });
        if (record(v) && v.supported === false) return undefined;
        if (
          !record(v) ||
          v.path !== path ||
          v.sha256 !== capture.sha256 ||
          v.bytes !== capture.bytes
        )
          throw Error("Binary memory source identity mismatch");
        // Independent ranges avoid downloading reused chunks or the gaps between them.
        return api.openDownload(host, path, capture.bytes);
      })();
      const bound = await opening;
      if (bound) return bound.read(offset, bytes);
      const v = await request("memory-export-read", {
        checkpointId: id,
        offset,
        bytes,
      });
      if (
        !record(v) ||
        v.offset !== offset ||
        v.bytes !== bytes ||
        typeof v.base64 !== "string"
      )
        throw Error("Invalid memory export range");
      return decodeBase64(v.base64, bytes);
    },
    async close() {
      if (closed) return;
      closed = true;
      const bound = await opening?.catch(() => undefined);
      try {
        await bound?.close();
      } finally {
        // Also reconcile an export left by a previous controller whose close
        // acknowledgement was lost after the combined root was published.
        const v = await request("memory-source-close", { checkpointId: id });
        if (!record(v) || (v.closed !== true && v.supported !== false))
          throw Error("Binary memory source cleanup unconfirmed");
      }
    },
  };
}
export async function boatMemoryImport(
  api: BoatApi,
  host: string,
  lease: HostLease,
  id: string,
  request: Request,
): Promise<MemoryImportSink | undefined> {
  const path = `/tmp/jetski-memory-imports/${prefix(lease, id)}/chunk.bin`;
  const v = await request("memory-import-file-begin", { checkpointId: id });
  if (record(v) && v.supported === false) return undefined;
  if (!record(v) || v.path !== path || v.chunkBytes !== HOST_IMPORT_CHUNK_BYTES)
    throw Error("Binary memory import identity mismatch");
  return {
    chunkBytes: HOST_IMPORT_CHUNK_BYTES,
    async write(objectId, offset, bytes, sha256) {
      await api.uploadMemoryPart(host, path, bytes);
      return request("memory-import-file-chunk", {
        checkpointId: id,
        objectId,
        offset,
        bytes: bytes.length,
        sha256,
      });
    },
    async close() {
      const v = await request("memory-import-file-close", { checkpointId: id });
      if (!record(v) || v.closed !== true)
        throw Error("Binary memory import cleanup unconfirmed");
    },
  };
}
