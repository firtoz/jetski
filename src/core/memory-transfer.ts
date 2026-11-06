import { type ArchiveSource, archiveChunks } from "./archive-source.js";
import type { CheckpointPublication } from "./checkpoint-publication.js";
import type { CheckpointRegistry, CheckpointRoot } from "./checkpoints.js";
import {
  type CheckpointStore,
  canonical,
  type Fence,
  type Json,
  type ObjectInfo,
  type StateStore,
  scopeKey,
} from "./contracts.js";
import { sameObject } from "./inventory.js";
import {
  type CapturedMemory,
  memoryCaptureJson,
  memoryCaptureManifest,
  parseMemoryCapture,
} from "./memory-capture.js";
import {
  decodeMemoryChunk,
  type MemoryChunkCodecAdapter,
} from "./memory-chunk-codec.js";
import { observeCheckpointObjects } from "./object-verification.js";
import type {
  MemoryChunkCodec,
  PortableMemoryChunk,
  PortableMemoryManifest,
} from "./portable-memory-format.js";
import {
  composePortableMemoryRoot,
  portableMemoryRoot,
} from "./portable-memory-root.js";
import { type StageTimingSink, timeStage } from "./timing.js";

type UploadJournal = {
  generation: number;
  inputSha256: string;
};
export type MemoryTransferMetrics = {
  uploadedBytes: number;
  reusedBytes: number;
  sourceBytes: number;
  sourceRequests: number;
  uploads: number;
};
const contentKey = (chunk: PortableMemoryChunk) =>
  `${chunk.codec}/${chunk.bytes}/${chunk.sha256}/${chunk.object.bytes}/${chunk.object.sha256}`;
/** Durable chunk attempts under an existing FS writer. Content keys index reuse;
 * physical IDs are persisted before PUT and never reused after a failed attempt. */
export class PortableMemoryTransfer {
  constructor(
    private state: StateStore,
    private registry: CheckpointRegistry,
    private store: CheckpointStore,
    private codecs: ReadonlyMap<MemoryChunkCodec, MemoryChunkCodecAdapter>,
    private newId: () => string = () => crypto.randomUUID(),
    private timings?: StageTimingSink,
  ) {}
  publication(
    fence: Fence,
    id: string,
    filesystemSha256: string,
    input: unknown,
    source: ArchiveSource,
    options: { reuse: boolean; previous?: string },
    metrics: MemoryTransferMetrics = {
      uploadedBytes: 0,
      reusedBytes: 0,
      sourceBytes: 0,
      sourceRequests: 0,
      uploads: 0,
    },
  ): CheckpointPublication {
    fence = {
      owner: fence.owner,
      sandbox: fence.sandbox,
      generation: fence.generation,
    };
    options = { ...options };
    if (typeof options.reuse !== "boolean")
      throw Error("Invalid memory reuse policy");
    const capture = parseMemoryCapture(input, fence, id, filesystemSha256);
    const template = memoryCaptureManifest(
      fence,
      id,
      filesystemSha256,
      capture,
    );
    const journalInput: Json = {
      capture: memoryCaptureJson(capture),
      filesystemSha256,
      reuse: options.reuse,
      previous: options.previous ?? null,
    };
    const key = `memory-upload/${scopeKey(fence)}/${id}`;
    const validate = (root: CheckpointRoot) => {
      const actual = portableMemoryRoot(root)?.memory;
      if (!actual)
        throw Error("Portable memory missing from published checkpoint");
      const logical = (value: PortableMemoryManifest) => ({
        ...value,
        files: value.files.map((file) => ({
          ...file,
          chunks: file.chunks.map((c) => ({
            offset: c.offset,
            bytes: c.bytes,
            sha256: c.sha256,
            codec: c.codec,
            storedBytes: c.object.bytes,
            storedSha256: c.object.sha256,
          })),
        })),
      });
      if (canonical(logical(actual)) !== canonical(logical(template)))
        throw Error("Portable memory publication identity conflict");
    };
    return {
      validate,
      prepare: async (filesystem) => {
        const inputBytes = new TextEncoder().encode(canonical(journalInput));
        const inputSha256 = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", inputBytes)),
          (b) => b.toString(16).padStart(2, "0"),
        ).join("");
        await this.state.transaction((tx) => {
          this.registry.requireWriterIn(tx, fence, id);
          const previous = tx.get<UploadJournal>(key);
          if (previous) {
            if (
              previous.generation !== fence.generation ||
              previous.inputSha256 !== inputSha256
            )
              throw Error("Memory upload identity conflict");
            return previous;
          }
          const record: UploadJournal = {
            generation: fence.generation,
            inputSha256,
          };
          tx.put(key, record);
          tx.put(key + "/input", journalInput);
          return record;
        });
        const result = structuredClone(template),
          available = new Map<string, ObjectInfo>();
        if (options.reuse && options.previous) {
          const root = await this.registry.root(fence, options.previous);
          const old = root ? portableMemoryRoot(root)?.memory : undefined;
          if (old)
            for (const file of old.files)
              for (const chunk of file.chunks)
                available.set(contentKey(chunk), chunk.object);
        }
        const extents = capture.files
          .flatMap((file, fi) =>
            file.chunks.map((capture, ci) => ({ capture, fi, ci })),
          )
          .sort((a, b) => a.capture.packedOffset - b.capture.packedOffset);
        for (const { capture: extent, fi, ci } of extents) {
          const index = `${fi}-${ci}`,
            chunk = result.files[fi]!.chunks[ci]!,
            content = contentKey(chunk);
          const planned = await this.state.transaction((tx) => {
            this.registry.requireWriterIn(tx, fence, id);
            return tx.get<ObjectInfo>(key + "/object/" + index);
          });
          const candidate =
            planned ?? (options.reuse ? available.get(content) : undefined);
          if (
            candidate &&
            (candidate.bytes !== extent.storedBytes ||
              candidate.sha256 !== extent.storedSha256)
          )
            throw Error("Memory upload journal object mismatch");
          const observed = candidate
            ? (
                await observeCheckpointObjects(
                  this.store,
                  fence,
                  [candidate],
                  true,
                  "Memory reuse integrity failure",
                )
              ).get(candidate.id)
            : undefined;
          let stored: ObjectInfo;
          if (observed) {
            stored = observed;
            metrics.reusedBytes += stored.bytes;
          } else {
            stored = {
              owner: fence.owner,
              sandbox: fence.sandbox,
              id: this.newId(),
              bytes: extent.storedBytes,
              sha256: extent.storedSha256,
            };
            await this.state.transaction((tx) => {
              this.registry.requireWriterIn(tx, fence, id);
              const record = tx.get<UploadJournal>(key);
              if (
                !record ||
                record.generation !== fence.generation ||
                record.inputSha256 !== inputSha256
              )
                throw Error("Memory upload journal changed");
              tx.put(key + "/object/" + index, stored);
            });
            const bytes = new Uint8Array(stored.bytes);
            let offset = 0;
            const counted: ArchiveSource = {
              readChunkBytes: source.readChunkBytes,
              read: async (start, count) => {
                metrics.sourceRequests++;
                const part = await timeStage(
                  this.timings,
                  "memory.source_read",
                  () => source.read(start, count),
                );
                metrics.sourceBytes += part.length;
                return part;
              },
            };
            for await (const part of archiveChunks(
              counted,
              extent.packedOffset,
              stored.bytes,
              1,
            )) {
              bytes.set(part, offset);
              offset += part.length;
            }
            const codec = this.codecs.get(chunk.codec);
            if (!codec) throw Error("Unsupported portable memory codec");
            await timeStage(this.timings, "memory.verify_encode", () =>
              decodeMemoryChunk({ ...chunk, object: stored }, bytes, codec),
            );
            await this.state.transaction((tx) =>
              this.registry.requireWriterIn(tx, fence, id),
            );
            metrics.uploads++;
            metrics.uploadedBytes += bytes.length;
            const receipt = await timeStage(this.timings, "memory.upload", () =>
              this.store.put(
                stored,
                (async function* () {
                  yield bytes;
                })(),
                stored,
              ),
            );
            if (!sameObject(stored, receipt))
              throw Error("Memory upload receipt mismatch");
          }
          await this.state.transaction((tx) => {
            this.registry.requireWriterIn(tx, fence, id);
            const record = tx.get<UploadJournal>(key);
            if (!record || record.inputSha256 !== inputSha256)
              throw Error("Memory upload journal changed");
            tx.put(key + "/object/" + index, stored);
          });
          result.files[fi]!.chunks[ci]!.object = stored;
          if (options.reuse) available.set(content, stored);
        }
        return composePortableMemoryRoot(filesystem, result);
      },
    };
  }
}
