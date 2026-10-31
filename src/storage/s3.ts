import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  type ByteStream,
  type CheckpointStore,
  DEFAULTS,
  identifier,
  type ObjectAddress,
  type ObjectInfo,
  type Scope,
} from "../core/contracts.js";

export type S3StoreOptions = {
  bucket: string;
  prefix: string;
  maxBytes?: number;
  timeoutMs?: number;
};
/** Dedicated namespace; credentials belong only to the controller. Reservations
 * are permanent and must never be removed by bucket lifecycle rules or collection.
 * Reads verify complete bounded objects before returning even a requested range. */
export class S3CheckpointStore implements CheckpointStore {
  private maxBytes: number;
  private timeoutMs: number;
  constructor(
    private client: Pick<S3Client, "send">,
    private options: S3StoreOptions,
  ) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket))
      throw Error("Invalid bucket name");
    if (
      !options.prefix ||
      options.prefix.length > 256 ||
      options.prefix
        .split("/")
        .some((part) => !/^[a-zA-Z0-9_-]{1,128}$/.test(part))
    )
      throw Error("Explicit safe namespace prefix required");
    this.maxBytes = options.maxBytes ?? DEFAULTS.maxObjectBytes;
    this.timeoutMs = options.timeoutMs ?? 30000;
    if (
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 1 ||
      this.maxBytes > DEFAULTS.maxObjectBytes ||
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 120000
    )
      throw Error("Invalid store bounds");
  }
  private scoped(scope: Scope, kind: "objects" | "reservations") {
    return `${this.options.prefix}/${identifier(scope.owner)}/${identifier(scope.sandbox)}/${kind}/`;
  }
  private key(
    address: ObjectAddress,
    kind: "objects" | "reservations" = "objects",
  ) {
    return `${this.scoped(address, kind)}${identifier(address.id)}`;
  }
  private signal() {
    return { abortSignal: AbortSignal.timeout(this.timeoutMs) };
  }
  async put(
    address: ObjectAddress,
    source: ByteStream,
    expected: { bytes: number; sha256: string },
  ): Promise<ObjectInfo> {
    if (
      !Number.isSafeInteger(expected.bytes) ||
      expected.bytes < 0 ||
      expected.bytes > this.maxBytes ||
      !/^[a-f0-9]{64}$/.test(expected.sha256)
    )
      throw Error("Invalid object metadata");
    const key = this.key(address);
    // Reservation ACK loss consumes the identity; callers observe or choose a fresh
    // ID. SDK retries cannot turn this conditional reservation into an overwrite.
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: this.key(address, "reservations"),
        Body: new Uint8Array(),
        ContentLength: 0,
        IfNoneMatch: "*",
      }),
      this.signal(),
    );
    const chunks: Buffer[] = [];
    const hash = createHash("sha256");
    let length = 0;
    for await (const chunk of source) {
      length += chunk.byteLength;
      if (length > expected.bytes)
        throw Error("Object exceeds declared length");
      hash.update(chunk);
      chunks.push(Buffer.from(chunk));
    }
    if (length !== expected.bytes || hash.digest("hex") !== expected.sha256)
      throw Error("Object integrity mismatch");
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: Buffer.concat(chunks),
        ContentLength: length,
        IfNoneMatch: "*",
        Metadata: {
          sha256: expected.sha256,
          bytes: String(length),
          format: "jetski-object-v1",
        },
      }),
      this.signal(),
    );
    const verified = await this.head(address);
    if (
      !verified ||
      verified.bytes !== length ||
      verified.sha256 !== expected.sha256
    )
      throw Error("Publication verification failed");
    return verified;
  }
  private async fetch(
    address: ObjectAddress,
  ): Promise<{ info: ObjectInfo; bytes: Buffer } | undefined> {
    let response;
    try {
      response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.options.bucket,
          Key: this.key(address),
        }),
        this.signal(),
      );
    } catch (error) {
      // A missing bucket, denied request or generic proxy 404 is not missing data.
      if (
        error &&
        typeof error === "object" &&
        "name" in error &&
        error.name === "NoSuchKey"
      )
        return undefined;
      throw error;
    }
    const body = response.Body;
    if (!(body instanceof Readable))
      throw Error("Node readable response required");
    const timeout = setTimeout(
      () => body.destroy(Error("Object read deadline exceeded")),
      this.timeoutMs,
    );
    try {
      const bytes = response.ContentLength,
        metadata = response.Metadata;
      if (
        typeof bytes !== "number" ||
        !Number.isSafeInteger(bytes) ||
        bytes < 0 ||
        bytes > this.maxBytes ||
        metadata?.format !== "jetski-object-v1" ||
        metadata.bytes !== String(bytes) ||
        !/^[a-f0-9]{64}$/.test(metadata.sha256 ?? "")
      )
        throw Error("Invalid object metadata");
      const chunks: Buffer[] = [];
      const hash = createHash("sha256");
      let length = 0;
      for await (const chunk of body) {
        if (!(chunk instanceof Uint8Array))
          throw Error("Invalid object stream");
        length += chunk.byteLength;
        if (length > bytes) throw Error("Object exceeds declared length");
        hash.update(chunk);
        chunks.push(Buffer.from(chunk));
      }
      if (length !== bytes || hash.digest("hex") !== metadata.sha256)
        throw Error("Stored object integrity mismatch");
      return {
        info: { ...address, bytes, sha256: metadata.sha256! },
        bytes: Buffer.concat(chunks),
      };
    } finally {
      clearTimeout(timeout);
      body.destroy();
    }
  }
  async head(address: ObjectAddress): Promise<ObjectInfo | undefined> {
    return (await this.fetch(address))?.info;
  }
  async *read(
    address: ObjectAddress,
    range?: { start: number; endExclusive: number },
  ): ByteStream {
    const object = await this.fetch(address);
    if (!object) throw Error("Object unavailable");
    const start = range?.start ?? 0,
      end = range?.endExclusive ?? object.info.bytes;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > object.info.bytes
    )
      throw Error("Invalid read range");
    for (let offset = start; offset < end; offset += 65536)
      yield object.bytes.subarray(offset, Math.min(end, offset + 65536));
  }
  async *list(scope: Scope): AsyncIterable<ObjectInfo> {
    const prefix = this.scoped(scope, "objects");
    let token: string | undefined,
      previousKey = "";
    const tokens = new Set<string>();
    for (let page = 0; page < 10000; page++) {
      const result = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.options.bucket,
          Prefix: prefix,
          MaxKeys: 1000,
          ContinuationToken: token,
        }),
        this.signal(),
      );
      if (
        result.Prefix !== prefix ||
        typeof result.IsTruncated !== "boolean" ||
        (result.CommonPrefixes?.length ?? 0) !== 0 ||
        !Number.isSafeInteger(result.KeyCount) ||
        result.KeyCount !== (result.Contents?.length ?? 0) ||
        (result.KeyCount ?? 0) > 1000
      )
        throw Error("Incomplete or ambiguous listing");
      for (const item of result.Contents ?? []) {
        if (!item.Key?.startsWith(prefix) || item.Key <= previousKey)
          throw Error("Unordered or foreign listing entry");
        const id = identifier(item.Key.slice(prefix.length));
        const info = await this.head({ ...scope, id });
        if (!info || info.bytes !== item.Size)
          throw Error("Listing changed during enumeration");
        previousKey = item.Key;
        yield info;
      }
      if (!result.IsTruncated) {
        if (result.NextContinuationToken)
          throw Error("Ambiguous final listing page");
        return;
      }
      token = result.NextContinuationToken;
      if (
        !token ||
        token.length > 8192 ||
        tokens.has(token) ||
        !result.KeyCount
      )
        throw Error("Invalid continuation token");
      tokens.add(token);
    }
    throw Error("Object listing exceeds page bound");
  }
  /** Only the core's fenced collector may invoke deletion. Identity stays reserved. */
  async delete(address: ObjectAddress): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.options.bucket,
        Key: this.key(address),
      }),
      this.signal(),
    );
  }
}
