import { encodeBase64 } from "./core/command-output.js";
import { identifier, type Json, type Operation } from "./core/contracts.js";
import {
  FILE_CHUNK_BYTES,
  type FileChunk,
  type FileListing,
  persistentPath,
} from "./core/files.js";
import type { UploadSpec, UploadStatus } from "./core/uploads.js";
export class JetskiClient {
  private readonly base: URL;
  constructor(
    url: string,
    private readonly token: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.base = new URL(url);
    if (
      this.base.protocol !== "https:" &&
      !(
        this.base.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(this.base.hostname)
      )
    )
      throw new Error("HTTPS required outside loopback");
    if (this.base.username || this.base.password)
      throw new Error("URL credentials prohibited");
  }
  async request<T>(path: string, method = "GET", body?: Json): Promise<T> {
    if (
      !path.startsWith("/v1/") ||
      path.split("?")[0]!.includes("..") ||
      path.includes("\\")
    )
      throw new Error("Invalid API path");
    const headers = {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
    };
    const options: RequestInit = { method, headers, redirect: "error" };
    if (body !== undefined) options.body = JSON.stringify(body);
    const response = await this.transport(new URL(path, this.base), options);
    if (!response.ok)
      throw new Error(`Jetski request failed (${response.status})`);
    return (await response.json()) as T;
  }
  readFile(
    sandbox: string,
    path: string,
    offset = 0,
    bytes = FILE_CHUNK_BYTES,
    version?: string,
  ): Promise<FileChunk> {
    const query = new URLSearchParams({
      path: persistentPath(path),
      offset: String(offset),
      bytes: String(bytes),
    });
    if (version) query.set("version", version);
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/files/read?${query}`,
    );
  }
  /** Incremental verified download. Mutating live files fail instead of mixing versions. */
  async *readFileStream(
    sandbox: string,
    path: string,
  ): AsyncIterable<Uint8Array> {
    let offset = 0;
    let version: string | undefined;
    let size: number | undefined;
    for (;;) {
      const chunk = await this.readFile(
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
  listFiles(
    sandbox: string,
    path: string,
    after = "",
    limit = 256,
    version?: string,
  ): Promise<FileListing> {
    const query = new URLSearchParams({
      path: persistentPath(path),
      after,
      limit: String(limit),
    });
    if (version) query.set("version", version);
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/files/list?${query}`,
    );
  }
  beginUpload(
    sandbox: string,
    id: string,
    spec: UploadSpec,
  ): Promise<UploadStatus> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/files/uploads`,
      "POST",
      { id, ...spec },
    );
  }
  uploadStatus(sandbox: string, id: string): Promise<UploadStatus> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/files/uploads/${identifier(id)}`,
    );
  }
  async uploadChunk(
    sandbox: string,
    id: string,
    offset: number,
    data: Uint8Array,
  ): Promise<UploadStatus> {
    if (!data.length || data.length > FILE_CHUNK_BYTES)
      throw Error("Invalid upload chunk size");
    const sha256 = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new Uint8Array(data).buffer),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/files/uploads/${identifier(id)}`,
      "PUT",
      { offset, base64: encodeBase64(data), sha256 },
    );
  }
  finishUpload(sandbox: string, id: string): Promise<UploadStatus> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/files/uploads/${identifier(id)}/finish`,
      "POST",
      {},
    );
  }
  /** Source starts at byte zero on retry. Metadata binds it to the original content. */
  async writeFileStream(
    sandbox: string,
    id: string,
    spec: UploadSpec,
    source: AsyncIterable<Uint8Array>,
  ): Promise<UploadStatus> {
    const receipt = await this.beginUpload(sandbox, id, spec);
    if (receipt.phase === "committed") return receipt;
    if (receipt.phase === "finishing") return this.finishUpload(sandbox, id);
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
        const observed = await this.uploadChunk(
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
    return this.finishUpload(sandbox, id);
  }
  operation(sandbox: string, id: string): Promise<Operation> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/operations/${identifier(id)}`,
    );
  }
}
