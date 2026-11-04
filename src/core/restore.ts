import { checkpointLayout } from "./checkpoint-layout.js";
import type { CheckpointRegistry } from "./checkpoints.js";
import { encodeBase64 } from "./command-output.js";
import type { CheckpointStore, Fence, Json } from "./contracts.js";
import { sameObject } from "./inventory.js";
import { validateRootPayload } from "./root-payload.js";
import {
  type CheckpointImportSink,
  HOST_IMPORT_CHUNK_BYTES,
  HOST_IMPORT_FILE_BYTES,
} from "./transport.js";

const sha = async (bytes: Uint8Array<ArrayBuffer>) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
/** Restore only through a retained root with reader exclusion. The host verifies
 * the complete archive and extracted tree before admitting workload execution. */
export async function restoreCheckpoint(
  objects: CheckpointStore,
  registry: CheckpointRegistry,
  fence: Fence,
  id: string,
  request: (action: string, payload: Json) => Promise<Json>,
  openImport?: () => Promise<CheckpointImportSink>,
  retainedReader?: string,
) {
  const reader = retainedReader ?? crypto.randomUUID();
  if (retainedReader) await registry.requireReader(fence, reader, id);
  else await registry.admit(fence, reader, "reader", id);
  let sink: CheckpointImportSink | undefined;
  try {
    const root = await registry.root(fence, id);
    if (!root) throw Error("Checkpoint missing");
    validateRootPayload(root);
    const layout = checkpointLayout(root),
      archive = layout.archive;
    const identities = new Map<string, (typeof root.frames)[number]>();
    for (const object of root.frames) {
      const previous = identities.get(object.id);
      if (
        object.owner !== fence.owner ||
        object.sandbox !== fence.sandbox ||
        (previous && !sameObject(previous, object))
      )
        throw Error("Restore object mismatch");
      identities.set(object.id, object);
    }
    const receipt = await request("import-begin", {
      checkpointId: id,
      sha256: archive.sha256,
      bytes: archive.bytes,
    });
    if (
      !receipt ||
      typeof receipt !== "object" ||
      Array.isArray(receipt) ||
      receipt.id !== id ||
      receipt.sha256 !== archive.sha256 ||
      receipt.bytes !== archive.bytes ||
      !Number.isSafeInteger(receipt.offset) ||
      typeof receipt.offset !== "number" ||
      receipt.offset < 0 ||
      receipt.offset > archive.bytes ||
      !["receiving", "extracting", "ready"].includes(String(receipt.phase)) ||
      (receipt.phase !== "receiving" && receipt.offset !== archive.bytes)
    )
      throw Error("Invalid import receipt");
    // Older immutable hosts omit the advertised bound and retain 256 KiB.
    // Larger durable chunks amortize host-control and fsync costs. Their larger
    // envelope is restricted to checkpoint import; durability/replay is unchanged.
    let chunkBytes = receipt.chunkBytes ?? 256 * 1024;
    if (
      ![256 * 1024, 512 * 1024, HOST_IMPORT_CHUNK_BYTES].includes(
        Number(chunkBytes),
      ) ||
      typeof chunkBytes !== "number"
    )
      throw Error("Invalid import chunk bound");
    const finish = async () => {
      const done = await request("import-finish", {});
      if (
        !done ||
        typeof done !== "object" ||
        Array.isArray(done) ||
        done.id !== id ||
        done.sha256 !== archive.sha256 ||
        done.bytes !== archive.bytes ||
        done.offset !== archive.bytes ||
        done.phase !== "ready"
      )
        throw Error("Invalid completed import receipt");
    };
    if (receipt.phase === "ready") return;
    const resumeOffset = receipt.offset as number;
    if (receipt.phase === "extracting") {
      await finish();
      return;
    }
    if (openImport && receipt.fileChunkBytes === HOST_IMPORT_FILE_BYTES) {
      sink = await openImport();
      if (sink.chunkBytes !== HOST_IMPORT_FILE_BYTES)
        throw Error("Invalid binary import bound");
      chunkBytes = sink.chunkBytes;
    }
    let frameOffset = 0,
      offset = resumeOffset,
      buffered = 0;
    const buffer = new Uint8Array(chunkBytes);
    const flush = async () => {
      if (!buffered) return;
      const part = buffer.subarray(0, buffered);
      const digest = await sha(part);
      const acknowledged = sink
        ? await sink.write(offset, part, digest)
        : await request("import-chunk", {
            offset,
            base64: encodeBase64(part),
            sha256: digest,
          });
      offset += part.length;
      if (
        !acknowledged ||
        typeof acknowledged !== "object" ||
        Array.isArray(acknowledged) ||
        acknowledged.id !== id ||
        acknowledged.sha256 !== archive.sha256 ||
        acknowledged.bytes !== archive.bytes ||
        acknowledged.offset !== offset ||
        acknowledged.phase !== "receiving"
      )
        throw Error("Invalid import chunk acknowledgement");
      buffered = 0;
    };
    const cache = new Map<string, Uint8Array<ArrayBuffer>>();
    const lastUse = new Map<string, number>();
    for (const [index, segment] of layout.segments.entries())
      lastUse.set(root.frames[segment.object]!.id, index);
    const load = async (
      object: (typeof root.frames)[number],
      index: number,
    ) => {
      // Drop an exhausted sequential pack before evicting one whose members
      // recur later. Sparse changed packs can then share the two-object cache.
      for (const key of cache.keys())
        if (lastUse.get(key)! < index) cache.delete(key);
      const cached = cache.get(object.id);
      if (cached) {
        cache.delete(object.id);
        cache.set(object.id, cached);
        return cached;
      }
      const full = new Uint8Array(object.bytes);
      let filled = 0;
      for await (const part of objects.read({
        owner: object.owner,
        sandbox: object.sandbox,
        id: object.id,
      })) {
        if (!(part instanceof Uint8Array) || filled + part.length > full.length)
          throw Error("Restore object grew");
        full.set(part, filled);
        filled += part.length;
      }
      if (filled !== full.length || (await sha(full)) !== object.sha256)
        throw Error("Restore integrity failure");
      cache.set(object.id, full);
      while (cache.size > 2) cache.delete(cache.keys().next().value!);
      return full;
    };
    for (let index = 0; index < archive.frames.length; index++) {
      const expected = archive.frames[index]!,
        segment = layout.segments[index]!;
      const frame = root.frames[segment.object]!;
      const frameStart = frameOffset;
      frameOffset += expected.bytes;
      if (frameOffset <= resumeOffset) continue;
      const physical = await load(frame, index);
      const full = physical.subarray(
        segment.offset,
        segment.offset + expected.bytes,
      );
      if (layout.packed && (await sha(full)) !== expected.sha256)
        throw Error("Restore slice integrity failure");
      let position = Math.max(0, resumeOffset - frameStart);
      // Only fully hash-verified frames enter the bounded transport buffer.
      // Coalesce frame tails instead of paying a control round trip for each.
      while (position < full.length) {
        const count = Math.min(chunkBytes - buffered, full.length - position);
        buffer.set(full.subarray(position, position + count), buffered);
        buffered += count;
        position += count;
        if (buffered === chunkBytes) await flush();
      }
    }
    await flush();
    if (offset !== archive.bytes) throw Error("Restore extent mismatch");
    await sink?.close();
    sink = undefined;
    await finish();
  } finally {
    try {
      await sink?.close();
    } finally {
      if (!retainedReader) await registry.close(fence, reader);
    }
  }
}
