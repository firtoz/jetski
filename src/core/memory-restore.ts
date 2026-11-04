import { checkpointArchive } from "./checkpoint-layout.js";
import type { CheckpointRegistry } from "./checkpoints.js";
import { encodeBase64 } from "./command-output.js";
import {
  type CheckpointStore,
  canonical,
  type Fence,
  identifier,
  type Json,
  type StateStore,
  scopeKey,
} from "./contracts.js";
import type { HostLease } from "./pool.js";
import {
  type PortableMemoryManifest,
  portableMemoryObjects,
} from "./portable-memory-format.js";
import { portableMemoryRoot } from "./portable-memory-root.js";
import { type WorkloadResources, workloadResources } from "./resources.js";
import { restoreCheckpoint } from "./restore.js";
import { type StageTimingSink, timeStage } from "./timing.js";
import {
  type CheckpointImportSink,
  HOST_IMPORT_CHUNK_BYTES,
  HostTransportError,
  type MemoryImportSink,
} from "./transport.js";

type RestoreRecord = Fence & {
  id: string;
  checkpointId: string;
  manifestSha256: string;
  reader: string;
  lease: HostLease;
  image: string;
  resources: WorkloadResources;
  stage: "filesystem" | "memory" | "native" | "fallback" | "done";
  portable: boolean | null;
  preserved: boolean | null;
  reason: string | null;
};
export type PortableRestoreResult = {
  memoryPreserved: boolean;
  fallbackReason: string | null;
};
const digest = async (bytes: Uint8Array<ArrayBuffer>) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
const object = (value: unknown): value is Record<string, Json> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Stable reader and restore intent span controller restart. Host target receipts
 * carry the same immutable manifest identity; native uncertainty is only observed.
 * This coordinator never starts a replacement application as silent fallback. */
export class PortableMemoryRestore {
  constructor(
    private state: StateStore,
    private registry: CheckpointRegistry,
    private objects: CheckpointStore,
    private timings?: StageTimingSink,
  ) {}
  private key(fence: Fence, id: string) {
    return `portable-restore/${scopeKey(fence)}/${id}`;
  }
  private async advance(record: RestoreRecord, change: Partial<RestoreRecord>) {
    const next = { ...record, ...change };
    await this.state.transaction((tx) => {
      const key = this.key(record, record.id),
        current = tx.get<RestoreRecord>(key);
      if (!current || canonical(current) !== canonical(record))
        throw Error("Portable restore journal changed");
      this.registry.requireReaderIn(
        tx,
        record,
        record.reader,
        record.checkpointId,
      );
      tx.put(key, next);
    });
    return next;
  }
  private async complete(
    record: RestoreRecord,
    preserved: boolean,
    reason: string | null,
  ): Promise<PortableRestoreResult> {
    await this.state.transaction((tx) => {
      const key = this.key(record, record.id),
        current = tx.get<RestoreRecord>(key);
      if (!current || canonical(current) !== canonical(record))
        throw Error("Portable restore journal changed");
      this.registry.requireReaderIn(
        tx,
        record,
        record.reader,
        record.checkpointId,
      );
      this.registry.closeIn(tx, record, record.reader);
      tx.put(key, { ...record, stage: "done", preserved, reason });
    });
    return { memoryPreserved: preserved, fallbackReason: reason };
  }
  async restore(
    fence: Fence,
    id: string,
    checkpointId: string,
    lease: HostLease,
    image: string,
    resources: WorkloadResources,
    request: (action: string, payload: Json) => Promise<Json>,
    openFilesystemImport?: () => Promise<CheckpointImportSink>,
    openMemoryImport?: () => Promise<MemoryImportSink | undefined>,
  ): Promise<PortableRestoreResult> {
    fence = {
      owner: fence.owner,
      sandbox: fence.sandbox,
      generation: fence.generation,
    };
    identifier(id);
    identifier(checkpointId);
    lease = structuredClone(lease);
    resources = workloadResources(resources);
    if (lease.owner !== fence.owner || lease.sandboxId !== fence.sandbox)
      throw Error("Portable target scope mismatch");
    const root = await this.registry.root(fence, checkpointId),
      portable = root ? portableMemoryRoot(root) : undefined;
    if (!portable || portable.memory.compatibility.image !== image)
      throw Error("Portable checkpoint unavailable");
    checkpointArchive(root!);
    const manifest: PortableMemoryManifest = portable.memory;
    const manifestSha256 = await digest(
      new TextEncoder().encode(canonical(manifest)),
    );
    let record = await this.state.transaction((tx) => {
      const key = this.key(fence, id),
        prior = tx.get<RestoreRecord>(key);
      if (prior) {
        if (
          prior.generation !== fence.generation ||
          prior.checkpointId !== checkpointId ||
          prior.manifestSha256 !== manifestSha256 ||
          canonical(prior.lease) !== canonical(lease) ||
          prior.image !== image ||
          canonical(prior.resources) !== canonical(resources)
        )
          throw Error("Portable restore identity conflict");
        return prior;
      }
      const reader = crypto.randomUUID();
      this.registry.admitIn(tx, fence, reader, "reader", checkpointId);
      const next: RestoreRecord = {
        ...fence,
        id,
        checkpointId,
        manifestSha256,
        reader,
        lease,
        image,
        resources,
        stage: "filesystem",
        portable: null,
        preserved: null,
        reason: null,
      };
      tx.put(key, next);
      return next;
    });
    if (record.stage === "done")
      return {
        memoryPreserved: record.preserved === true,
        fallbackReason: record.reason,
      };
    const validate = (value: Json) => {
      if (
        !object(value) ||
        value.id !== checkpointId ||
        value.sha256 !== manifestSha256 ||
        value.filesystemSha256 !== manifest.filesystemSha256 ||
        canonical(value.lease ?? null) !== canonical(lease) ||
        typeof value.phase !== "string" ||
        value.memoryPreserved !== (value.phase === "restored")
      )
        throw Error("Portable target receipt identity mismatch");
      return value;
    };
    const status = async () =>
      validate(await request("memory-import-status", { checkpointId }));
    if (record.stage === "filesystem") {
      if (record.portable === null) {
        const capabilities = await request("status", {});
        const supported =
          object(capabilities) && capabilities.portableMemoryVersion === 1;
        record = await this.advance(record, {
          portable: supported,
          reason: supported ? null : "runtime-unsupported",
        });
      }
      await request("claim", { lease });
      await timeStage(this.timings, "memory.filesystem_restore", () =>
        restoreCheckpoint(
          this.objects,
          this.registry,
          fence,
          checkpointId,
          (action, payload) =>
            request(action, {
              ...(payload as Record<string, Json>),
              ...(action === "import-begin" && record.portable
                ? { portableMemoryRequired: true }
                : {}),
            }),
          openFilesystemImport,
          record.reader,
        ),
      );
      if (!record.portable) return this.complete(record, false, record.reason);
      record = await this.advance(record, { stage: "memory" });
    }
    if (record.stage === "memory") {
      const begin = validate(
        await request("memory-import-begin", {
          manifest,
          manifestSha256,
          image,
          ...resources,
        }),
      );
      if (begin.phase === "restored") return this.complete(record, true, null);
      if (begin.phase === "restoring")
        throw new HostTransportError(
          "Portable restore effect is still uncertain",
        );
      if (begin.phase === "rejected")
        record = await this.advance(record, {
          stage: "fallback",
          reason:
            typeof begin.reason === "string"
              ? begin.reason
              : "memory-unavailable",
        });
      else if (begin.phase !== "receiving")
        throw Error("Portable target not receiving");
      if (record.stage === "memory") {
        const sink = await openMemoryImport?.();
        try {
          if (sink && sink.chunkBytes !== HOST_IMPORT_CHUNK_BYTES)
            throw Error("Invalid memory import bound");
          for (const source of portableMemoryObjects(manifest)) {
            let reply = validate(
              await request("memory-import-status", {
                checkpointId,
                objectId: source.id,
              }),
            );
            const receipt = (value: Record<string, Json>) => {
              const part = value.object;
              if (
                !object(part) ||
                part.id !== source.id ||
                typeof part.offset !== "number" ||
                !Number.isSafeInteger(part.offset) ||
                part.offset < 0 ||
                part.offset > source.bytes ||
                part.complete !== (part.offset === source.bytes)
              )
                throw Error("Invalid portable object cursor");
              return part.offset;
            };
            let offset = receipt(reply);
            if (offset === source.bytes) continue;
            const bytes = new Uint8Array(source.bytes);
            let count = 0;
            try {
              for await (const part of this.objects.read(source)) {
                if (count + part.length > bytes.length)
                  throw Error("Portable stored object exceeds bound");
                bytes.set(part, count);
                count += part.length;
              }
            } catch (error) {
              if ((await this.objects.head(source)) === undefined) {
                record = await this.advance(record, {
                  stage: "fallback",
                  reason: "memory-object-missing",
                });
                break;
              }
              throw error;
            }
            if (
              count !== source.bytes ||
              (await digest(bytes)) !== source.sha256
            ) {
              record = await this.advance(record, {
                stage: "fallback",
                reason: "memory-object-integrity",
              });
              break;
            }
            while (offset < bytes.length) {
              const chunk = bytes.subarray(
                offset,
                Math.min(bytes.length, offset + HOST_IMPORT_CHUNK_BYTES),
              );
              const expected = offset + chunk.length;
              try {
                const part = sink
                  ? await sink.write(
                      source.id,
                      offset,
                      chunk,
                      await digest(chunk),
                    )
                  : await request("memory-import-chunk", {
                      checkpointId,
                      objectId: source.id,
                      offset,
                      base64: encodeBase64(chunk),
                      sha256: await digest(chunk),
                    });
                if (
                  !object(part) ||
                  part.id !== source.id ||
                  part.offset !== expected ||
                  part.complete !== (expected === source.bytes)
                )
                  throw Error("Portable import acknowledgement mismatch");
                offset = expected;
              } catch (error) {
                reply = validate(
                  await request("memory-import-status", {
                    checkpointId,
                    objectId: source.id,
                  }),
                );
                const observed = receipt(reply);
                if (observed !== expected) throw error;
                offset = observed;
              }
            }
          }
        } finally {
          await sink?.close();
        }
        if (record.stage === "memory")
          record = await this.advance(record, { stage: "native" });
      }
    }
    if (record.stage === "native") {
      let observed = await status();
      if (observed.phase === "restored")
        return this.complete(record, true, null);
      if (observed.phase === "restoring")
        throw new HostTransportError(
          "Portable restore effect is still uncertain",
        );
      if (
        !["receiving", "assembling", "ready"].includes(String(observed.phase))
      )
        throw Error("Portable native admission unavailable");
      try {
        observed = validate(
          await timeStage(this.timings, "memory.native_restore", () =>
            request("memory-import-finish", { checkpointId, manifestSha256 }),
          ),
        );
      } catch (error) {
        observed = await status();
        if (observed.phase !== "restored") throw error;
      }
      if (observed.phase !== "restored" || observed.memoryPreserved !== true)
        throw new HostTransportError("Portable memory restore unconfirmed");
      return this.complete(record, true, null);
    }
    if (record.stage === "fallback") {
      let observed = await status();
      if (observed.phase === "restored")
        return this.complete(record, true, null);
      if (observed.phase === "restoring")
        throw new HostTransportError(
          "Portable restore effect is still uncertain",
        );
      if (observed.phase !== "filesystem")
        observed = validate(
          await request("memory-import-abort", {
            checkpointId,
            manifestSha256,
          }),
        );
      if (observed.phase !== "filesystem" || observed.memoryPreserved !== false)
        throw Error("Portable fallback cleanup unconfirmed");
      return this.complete(record, false, record.reason);
    }
    throw Error("Portable restore stage incomplete");
  }
}
