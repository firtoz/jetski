import { FILE_CHUNK_BYTES } from "../core/files.js";
import type { UploadSpec, UploadStatus } from "../core/uploads.js";
import type { JetskiClient } from "../sdk.js";

// Shared verified file helpers for HTTP and in-process controller adapters.
export async function* readFileChunks(
  client: Pick<JetskiClient, "readFile">,
  sandbox: string,
  path: string,
): AsyncIterable<Uint8Array> {
  let offset = 0;
  let version: string | undefined;
  let size: number | undefined;
  for (;;) {
    const chunk = await client.readFile(
      sandbox,
      path,
      offset,
      FILE_CHUNK_BYTES,
      version,
    );
    if (
      typeof chunk.base64 !== "string" ||
      chunk.base64.length > Math.ceil(FILE_CHUNK_BYTES / 3) * 4
    )
      throw Error("Invalid file chunk");
    const data = Uint8Array.from(atob(chunk.base64), (char) =>
      char.charCodeAt(0),
    );
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    if (
      data.length > FILE_CHUNK_BYTES ||
      chunk.offset !== offset ||
      chunk.nextOffset !== offset + data.length ||
      !Number.isSafeInteger(chunk.size) ||
      chunk.size < chunk.nextOffset ||
      chunk.sha256 !== digest ||
      typeof chunk.version !== "string" ||
      !/^[a-f0-9]{64}$/.test(chunk.version) ||
      (version !== undefined && chunk.version !== version) ||
      (size !== undefined && chunk.size !== size) ||
      chunk.eof !== (chunk.nextOffset === chunk.size) ||
      (!data.length && !chunk.eof)
    )
      throw Error("Invalid or changed file stream");
    version = chunk.version;
    size = chunk.size;
    offset = chunk.nextOffset;
    if (data.length) yield data;
    if (chunk.eof) return;
  }
}
export async function writeFileChunks(
  client: Pick<JetskiClient, "beginUpload" | "finishUpload" | "uploadChunk">,
  sandbox: string,
  id: string,
  spec: UploadSpec,
  source: AsyncIterable<Uint8Array>,
): Promise<UploadStatus> {
  const receipt = await client.beginUpload(sandbox, id, spec);
  if (receipt.phase === "committed") return receipt;
  if (receipt.phase === "finishing") return client.finishUpload(sandbox, id);
  if (
    receipt.phase !== "receiving" ||
    !Number.isSafeInteger(receipt.offset) ||
    receipt.offset < 0 ||
    receipt.offset > spec.bytes
  )
    throw Error("Upload cannot resume");
  let offset = 0;
  for await (const part of source) {
    if (offset + part.length > spec.bytes)
      throw Error("Upload exceeds declared size");
    for (
      let start = Math.max(0, receipt.offset - offset);
      start < part.length;
      start += FILE_CHUNK_BYTES
    ) {
      const chunk = part.subarray(
        start,
        Math.min(start + FILE_CHUNK_BYTES, part.length),
      );
      const observed = await client.uploadChunk(
        sandbox,
        id,
        offset + start,
        chunk,
      );
      if (
        observed.phase !== "receiving" ||
        observed.offset < offset + start + chunk.length ||
        observed.offset > spec.bytes
      )
        throw Error("Invalid upload acknowledgement");
    }
    offset += part.length;
  }
  if (offset !== spec.bytes) throw Error("Upload source ended early");
  return client.finishUpload(sandbox, id);
}
