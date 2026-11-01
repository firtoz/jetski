import type { CheckpointRegistry } from "./checkpoints.js";
import { encodeBase64 } from "./command-output.js";
import type { CheckpointStore, Fence, Json } from "./contracts.js";
import { validateRootPayload } from "./root-payload.js";
import { parseArchive } from "./transfer.js";

const sha = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
    ),
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
) {
  const reader = crypto.randomUUID();
  await registry.admit(fence, reader, "reader", id);
  try {
    const root = await registry.root(fence, id);
    if (!root) throw Error("Checkpoint missing");
    validateRootPayload(root);
    const archive = parseArchive(root.metadata);
    if (root.frames.length !== archive.frames.length)
      throw Error("Restore frame count mismatch");
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
    // Larger durable chunks amortize host-control and fsync costs without
    // changing acknowledgement or replay semantics, within the 1 MiB envelope.
    const chunkBytes = receipt.chunkBytes ?? 256 * 1024;
    if (chunkBytes !== 256 * 1024 && chunkBytes !== 512 * 1024)
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
    let frameOffset = 0,
      offset = resumeOffset,
      buffered = 0;
    const buffer = new Uint8Array(chunkBytes);
    const flush = async () => {
      if (!buffered) return;
      const part = buffer.subarray(0, buffered);
      const acknowledged = await request("import-chunk", {
        offset,
        base64: encodeBase64(part),
        sha256: await sha(part),
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
    for (let index = 0; index < root.frames.length; index++) {
      const frame = root.frames[index]!,
        expected = archive.frames[index]!;
      if (
        frame.owner !== fence.owner ||
        frame.sandbox !== fence.sandbox ||
        frame.bytes !== expected.bytes ||
        frame.sha256 !== expected.sha256
      )
        throw Error("Restore object mismatch");
      const frameStart = frameOffset;
      frameOffset += frame.bytes;
      if (frameOffset <= resumeOffset) continue;
      const full = new Uint8Array(frame.bytes);
      let filled = 0;
      for await (const part of objects.read(frame)) {
        if (filled + part.length > full.length)
          throw Error("Restore object grew");
        full.set(part, filled);
        filled += part.length;
      }
      if (filled !== full.length || (await sha(full)) !== frame.sha256)
        throw Error("Restore integrity failure");
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
    await finish();
  } finally {
    await registry.close(fence, reader);
  }
}
