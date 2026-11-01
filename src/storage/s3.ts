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
  type ObjectRange,
  type ObjectWriteMetadata,
  type Scope,
} from "../core/contracts.js";

import { objectRanges } from "../core/object-ranges.js";

export type S3StoreOptions = {
  bucket: string;
  prefix: string;
  maxBytes?: number;
  timeoutMs?: number;
  listPageSize?: number;
  /** Bounded, process-local receipts; zero disables conditional verification. */
  verifiedCacheEntries?: number;
};
type VerifiedObject = {
  info: ObjectInfo;
  etag: string;
  ranges?: ReadonlyMap<string, string>;
};
const MAX_CACHED_OBJECT_RANGES = 128;

/** Dedicated namespace; credentials belong only to the controller. Reservations
 * are permanent and must never be removed by bucket lifecycle rules or collection.
 * Reads verify complete bounded objects before returning even a requested range. */
export class S3CheckpointStore implements CheckpointStore {
  readonly verificationConcurrency = DEFAULTS.verificationConcurrency;
  readonly transferConcurrency = DEFAULTS.transferConcurrency;
  private maxBytes: number;
  private timeoutMs: number;
  private listPageSize: number;
  private verifiedCacheEntries: number;
  private verified = new Map<string, VerifiedObject>();
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
    this.listPageSize = options.listPageSize ?? 1000;
    this.verifiedCacheEntries = options.verifiedCacheEntries ?? 1024;
    if (
      !Number.isSafeInteger(this.verifiedCacheEntries) ||
      this.verifiedCacheEntries < 0 ||
      this.verifiedCacheEntries > 10000
    )
      throw Error("Invalid verification cache bound");
    if (
      !Number.isSafeInteger(this.listPageSize) ||
      this.listPageSize < 1 ||
      this.listPageSize > 1000
    )
      throw Error("Invalid listing page bound");
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
    expected: ObjectWriteMetadata,
  ): Promise<ObjectInfo> {
    if (
      !Number.isSafeInteger(expected.bytes) ||
      expected.bytes < 0 ||
      expected.bytes > this.maxBytes ||
      !/^[a-f0-9]{64}$/.test(expected.sha256)
    )
      throw Error("Invalid object metadata");
    const ranges = expected.ranges
      ? objectRanges(expected.ranges, expected.bytes)
      : undefined;
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
    // Every successful new upload receives a full byte/hash readback.
    const verified = (await this.fetch(address, undefined, ranges))?.info;
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
    prior?: VerifiedObject,
    ranges?: readonly ObjectRange[],
  ): Promise<{ info: ObjectInfo; bytes?: Buffer } | undefined> {
    const key = this.key(address);
    let response;
    try {
      response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
          ...(prior ? { IfNoneMatch: prior.etag } : {}),
        }),
        this.signal(),
      );
    } catch (error) {
      if (prior && error && typeof error === "object" && "$metadata" in error) {
        const metadata = error.$metadata;
        if (
          metadata &&
          typeof metadata === "object" &&
          "httpStatusCode" in metadata &&
          metadata.httpStatusCode === 304
        ) {
          if (this.verified.get(key) !== prior)
            throw Error("Verification invalidated during observation");
          this.remember(key, prior);
          return { info: { ...prior.info } };
        }
      }
      this.verified.delete(key);
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
    if (!(body instanceof Readable)) {
      this.verified.delete(key);
      throw Error("Node readable response required");
    }
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
      const info = { ...address, bytes, sha256: metadata.sha256! };
      const payload = Buffer.concat(chunks);
      let proofs: ReadonlyMap<string, string> | undefined;
      if (ranges) {
        const checked = objectRanges(ranges, bytes);
        for (const range of checked) {
          const digest = createHash("sha256")
            .update(payload.subarray(range.start, range.endExclusive))
            .digest("hex");
          if (digest !== range.sha256)
            throw Error("Object slice integrity failure");
        }
        if (checked.length <= MAX_CACHED_OBJECT_RANGES)
          proofs = new Map(
            checked.map((range) => [
              `${range.start}/${range.endExclusive}`,
              range.sha256,
            ]),
          );
      }
      this.verified.delete(key);
      // Only strong, bounded entity tags from a fully hashed response qualify.
      // ETags are validators, never substitutes for the SHA-256 integrity check.
      if (
        typeof response.ETag === "string" &&
        /^"[\x21\x23-\x7e]{1,256}"$/.test(response.ETag)
      ) {
        const receipt: VerifiedObject = {
          info: { ...info },
          etag: response.ETag,
          ...(proofs ? { ranges: proofs } : {}),
        };
        this.remember(key, receipt);
      }
      return { info, bytes: payload };
    } catch (error) {
      this.verified.delete(key);
      throw error;
    } finally {
      clearTimeout(timeout);
      body.destroy();
    }
  }
  private remember(key: string, value: VerifiedObject) {
    if (!this.verifiedCacheEntries) return;
    this.verified.delete(key);
    this.verified.set(key, value);
    while (this.verified.size > this.verifiedCacheEntries) {
      const oldest = this.verified.keys().next().value;
      if (oldest !== undefined) this.verified.delete(oldest);
    }
  }
  async head(address: ObjectAddress): Promise<ObjectInfo | undefined> {
    return (await this.fetch(address, this.verified.get(this.key(address))))
      ?.info;
  }
  async verifyRanges(
    address: ObjectAddress,
    input: readonly ObjectRange[],
  ): Promise<ObjectInfo | undefined> {
    const ranges = objectRanges(input, this.maxBytes);
    const key = this.key(address),
      prior = this.verified.get(key);
    const reusable =
      prior &&
      ranges.every(
        (range) =>
          prior.ranges?.get(`${range.start}/${range.endExclusive}`) ===
          range.sha256,
      );
    const object = await this.fetch(
      address,
      reusable ? prior : undefined,
      ranges,
    );
    return object ? { ...object.info } : undefined;
  }
  async *read(
    address: ObjectAddress,
    range?: { start: number; endExclusive: number },
  ): ByteStream {
    const object = await this.fetch(address);
    if (!object?.bytes) throw Error("Object unavailable");
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
          MaxKeys: this.listPageSize,
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
        (result.KeyCount ?? 0) > this.listPageSize
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
    this.verified.delete(this.key(address));
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.options.bucket,
        Key: this.key(address),
      }),
      this.signal(),
    );
  }
}
