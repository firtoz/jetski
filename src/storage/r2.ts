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
import { ObjectStreamVerifier } from "./integrity.js";

const LIST_PAGE_SIZE = 64;
const LIST_MAX_PAGES = 10_000;
const READ_PART_BYTES = 65_536;

const VERIFIED_CACHE_ENTRIES = 1024;
const VERIFIED_RANGE_ENTRIES = 128;
type VerifiedObject = {
  info: ObjectInfo;
  etag: string;
  ranges?: ReadonlyMap<string, string>;
  version?: string;
  providerSha256?: true;
};

export interface R2ObjectMetadata {
  key: string;
  size: number;
  etag?: string;
  version?: string;
  customMetadata?: Record<string, string>;
  checksums?: { sha256?: ArrayBuffer };
}
type R2Readable = {
  getReader(): {
    read(): Promise<
      | { done: true; value?: Uint8Array | undefined }
      | { done: false; value: Uint8Array }
    >;
    cancel(): Promise<unknown>;
  };
};
/** Structural native binding port; importing this adapter loads no framework. */
export interface R2BucketPort {
  put(
    key: string,
    bytes: Uint8Array<ArrayBuffer>,
    options?: {
      onlyIf?: { etagDoesNotMatch: string };
      customMetadata?: Record<string, string>;
      sha256?: ArrayBuffer;
    },
  ): Promise<R2ObjectMetadata | null>;
  get(
    key: string,
    options?: { onlyIf?: { etagDoesNotMatch: string } },
  ): Promise<(R2ObjectMetadata & { body?: R2Readable }) | null>;
  list(options: { prefix: string; limit: number; cursor?: string }): Promise<{
    objects: Array<{ key: string; size: number }>;
    delimitedPrefixes: string[];
    truncated: boolean;
    cursor?: string | undefined;
  }>;
  delete(key: string): Promise<void>;
}
export const R2_WRITE_VERIFICATION = ["readback", "provider-sha256"] as const;
export type R2WriteVerification = (typeof R2_WRITE_VERIFICATION)[number];
export type R2StoreOptions = { writeVerification?: R2WriteVerification };
const validValidator = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[\x21-\x7e]{1,256}$/.test(value) &&
  !value.startsWith("W/") &&
  !value.includes('"');
function providerChecksum(object: R2ObjectMetadata): string | undefined {
  const value = object.checksums?.sha256;
  if (value === undefined) return undefined;
  if (!(value instanceof ArrayBuffer) || value.byteLength !== 32)
    throw Error("Invalid R2 SHA-256 receipt");
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Dedicated prefix, separate from legacy archives. Reservation markers never
 * expire: even a failed or deleted object's physical identity stays consumed. */
export class R2CheckpointStore implements CheckpointStore {
  readonly verificationConcurrency = DEFAULTS.verificationConcurrency;
  readonly transferConcurrency = DEFAULTS.transferConcurrency;
  private readonly verified = new Map<string, VerifiedObject>();
  private readonly writeVerification: R2WriteVerification;
  private remember(key: string, receipt: VerifiedObject) {
    this.verified.delete(key);
    this.verified.set(key, receipt);
    while (this.verified.size > VERIFIED_CACHE_ENTRIES) {
      const oldest = this.verified.keys().next().value;
      if (oldest !== undefined) {
        this.verified.delete(oldest);
      }
    }
  }
  constructor(
    private readonly bucket: R2BucketPort,
    private readonly prefix: string,
    options: R2StoreOptions = {},
  ) {
    this.writeVerification = options.writeVerification ?? "readback";
    if (!R2_WRITE_VERIFICATION.includes(this.writeVerification))
      throw Error("Invalid R2 verification policy");
    if (
      !prefix ||
      prefix.length > 256 ||
      prefix.split("/").some((part) => !/^[a-zA-Z0-9_-]{1,128}$/.test(part))
    ) {
      throw Error("Explicit Jetski R2 namespace required");
    }
  }
  private scoped(scope: Scope, kind: "objects" | "reservations") {
    return `${this.prefix}/${identifier(scope.owner)}/${identifier(scope.sandbox)}/${kind}/`;
  }
  private key(
    address: ObjectAddress,
    kind: "objects" | "reservations" = "objects",
  ) {
    return `${this.scoped(address, kind)}${identifier(address.id)}`;
  }
  async put(
    address: ObjectAddress,
    source: ByteStream,
    expected: ObjectWriteMetadata,
  ): Promise<ObjectInfo> {
    if (
      !Number.isSafeInteger(expected.bytes) ||
      expected.bytes < 0 ||
      expected.bytes > DEFAULTS.maxObjectBytes ||
      !/^[a-f0-9]{64}$/.test(expected.sha256)
    ) {
      throw Error("Invalid Jetski object metadata");
    }
    address = { ...address };
    expected = {
      bytes: expected.bytes,
      sha256: expected.sha256,
      ...(expected.ranges
        ? { ranges: objectRanges(expected.ranges, expected.bytes) }
        : {}),
    };
    const reserved = await this.bucket.put(
      this.key(address, "reservations"),
      new Uint8Array(),
      {
        onlyIf: { etagDoesNotMatch: "*" },
      },
    );
    if (!reserved) {
      throw Error("Jetski object identity already reserved");
    }
    const body = new Uint8Array(expected.bytes);
    const verifier = new ObjectStreamVerifier(expected, expected.ranges);
    let bytes = 0;
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array)) {
        throw Error("Invalid Jetski object stream");
      }
      const offset = bytes;
      bytes += chunk.byteLength;
      if (bytes > expected.bytes) {
        throw Error("Jetski object exceeds declared size");
      }
      body.set(chunk, offset);
      verifier.update(body.subarray(offset, bytes));
    }
    const proofs = verifier.finish();
    const written = await this.bucket.put(this.key(address), body, {
      onlyIf: { etagDoesNotMatch: "*" },
      customMetadata: {
        format: "jetski-object-v1",
        bytes: String(bytes),
        sha256: expected.sha256,
      },
      ...(this.writeVerification === "provider-sha256"
        ? {
            sha256: Uint8Array.from(expected.sha256.match(/../g)!, (value) =>
              Number.parseInt(value, 16),
            ).buffer,
          }
        : {}),
    });
    if (!written) {
      throw Error("Jetski object already exists");
    }
    if (this.writeVerification === "provider-sha256") {
      const checksum = providerChecksum(written);
      if (checksum !== undefined) {
        if (
          checksum !== expected.sha256 ||
          written.key !== this.key(address) ||
          written.size !== bytes ||
          written.customMetadata?.format !== "jetski-object-v1" ||
          written.customMetadata.bytes !== String(bytes) ||
          written.customMetadata.sha256 !== expected.sha256
        )
          throw Error("R2 verified-write receipt conflicts");
        if (validValidator(written.etag) && validValidator(written.version)) {
          const info = { ...address, bytes, sha256: expected.sha256 };
          this.remember(this.key(address), {
            info,
            etag: written.etag,
            version: written.version,
            providerSha256: true,
            ...(expected.ranges && proofs.size <= VERIFIED_RANGE_ENTRIES
              ? { ranges: proofs }
              : {}),
          });
          return { ...info };
        }
      }
    }
    const verified = (await this.fetch(address, undefined, expected.ranges))
      ?.info;
    if (
      !verified ||
      verified.bytes !== bytes ||
      verified.sha256 !== expected.sha256
    ) {
      throw Error("Jetski publication verification failed");
    }
    return verified;
  }
  private async fetch(
    address: ObjectAddress,
    prior?: VerifiedObject,
    ranges?: readonly ObjectRange[],
    retainBytes = false,
  ): Promise<{ info: ObjectInfo; bytes?: Uint8Array } | undefined> {
    address = { ...address };
    const key = this.key(address);
    let object: (R2ObjectMetadata & { body?: R2Readable }) | null;
    try {
      object = await this.bucket.get(
        key,
        prior ? { onlyIf: { etagDoesNotMatch: prior.etag } } : {},
      );
    } catch (error) {
      this.verified.delete(key);
      throw error;
    }
    if (!object) {
      this.verified.delete(key);
      return undefined;
    }
    const reader = object.body?.getReader();
    try {
      const metadata = object.customMetadata;
      const storedSha256 = metadata?.sha256;
      if (
        object.key !== key ||
        !Number.isSafeInteger(object.size) ||
        object.size < 0 ||
        object.size > DEFAULTS.maxObjectBytes ||
        metadata?.["format"] !== "jetski-object-v1" ||
        metadata["bytes"] !== String(object.size) ||
        typeof storedSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(storedSha256)
      ) {
        throw Error("Invalid stored Jetski object metadata");
      }
      if (!reader) {
        // A failed conditional GET is useful only with this exact still-live proof.
        // It never turns unverified metadata or an ETag alone into an integrity proof.
        if (
          !prior ||
          this.verified.get(key) !== prior ||
          object.etag !== prior.etag ||
          (prior.version !== undefined && object.version !== prior.version) ||
          object.size !== prior.info.bytes ||
          storedSha256 !== prior.info.sha256
        ) {
          throw Error("Jetski conditional verification invalidated");
        }
        if (prior.providerSha256) {
          const checksum = providerChecksum(object);
          if (checksum === undefined) {
            this.verified.delete(key);
            return this.fetch(address, undefined, ranges, retainBytes);
          }
          if (checksum !== prior.info.sha256)
            throw Error("R2 conditional checksum changed");
        }
        this.remember(key, prior);
        return { info: { ...prior.info } };
      }
      const bytes = retainBytes ? new Uint8Array(object.size) : undefined;
      const verifier = new ObjectStreamVerifier(
        { bytes: object.size, sha256: storedSha256 },
        ranges,
      );
      let offset = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) {
          break;
        }
        verifier.update(part.value);
        bytes?.set(part.value, offset);
        offset += part.value.length;
      }
      const checkedProofs = verifier.finish();
      const info = {
        ...address,
        bytes: object.size,
        sha256: storedSha256,
      };
      let proofs: ReadonlyMap<string, string> | undefined;
      if (ranges && checkedProofs.size <= VERIFIED_RANGE_ENTRIES) {
        proofs = checkedProofs;
      }
      this.verified.delete(key);
      if (validValidator(object.etag)) {
        this.remember(key, {
          info: { ...info },
          etag: object.etag,
          ...(validValidator(object.version)
            ? { version: object.version }
            : {}),
          ...(proofs ? { ranges: proofs } : {}),
        });
      }
      return { info, ...(bytes ? { bytes } : {}) };
    } catch (error) {
      this.verified.delete(key);
      throw error;
    } finally {
      await reader?.cancel();
    }
  }
  async head(address: ObjectAddress) {
    return (await this.fetch(address, this.verified.get(this.key(address))))
      ?.info;
  }
  async verifyRanges(address: ObjectAddress, input: readonly ObjectRange[]) {
    const ranges = objectRanges(input),
      prior = this.verified.get(this.key(address));
    const reusable =
      prior &&
      ranges.every(
        (range) =>
          prior.ranges?.get(`${range.start}/${range.endExclusive}`) ===
          range.sha256,
      );
    return (await this.fetch(address, reusable ? prior : undefined, ranges))
      ?.info;
  }
  async *read(
    address: ObjectAddress,
    range?: { start: number; endExclusive: number },
  ): ByteStream {
    const object = await this.fetch(address, undefined, undefined, true);
    if (!object?.bytes) {
      throw Error("Jetski object unavailable");
    }
    const start = range?.start ?? 0;
    const end = range?.endExclusive ?? object.bytes.length;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > object.bytes.length
    ) {
      throw Error("Invalid Jetski object range");
    }
    for (let at = start; at < end; at += READ_PART_BYTES) {
      yield object.bytes.subarray(at, Math.min(end, at + READ_PART_BYTES));
    }
  }
  async *list(scope: Scope): AsyncIterable<ObjectInfo> {
    const prefix = this.scoped(scope, "objects");
    let cursor: string | undefined;
    let previousKey = "";
    const cursors = new Set<string>();
    for (let page = 0; page < LIST_MAX_PAGES; page++) {
      const result = await this.bucket.list({
        prefix,
        limit: LIST_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      if (
        typeof result.truncated !== "boolean" ||
        !Array.isArray(result.objects) ||
        result.objects.length > LIST_PAGE_SIZE ||
        result.delimitedPrefixes.length
      ) {
        throw Error("Ambiguous Jetski object inventory");
      }
      for (const object of result.objects) {
        if (!object.key.startsWith(prefix) || object.key <= previousKey) {
          throw Error("Unordered or foreign Jetski object entry");
        }
        const info = await this.head({
          ...scope,
          id: identifier(object.key.slice(prefix.length)),
        });
        if (!info || info.bytes !== object.size) {
          throw Error("Jetski inventory changed during enumeration");
        }
        previousKey = object.key;
        yield info;
      }
      if (!result.truncated) {
        return;
      }
      cursor = result.cursor;
      if (!cursor || cursor.length > 8192 || cursors.has(cursor)) {
        throw Error("Invalid Jetski inventory cursor");
      }
      cursors.add(cursor);
    }
    throw Error("Jetski inventory page bound exceeded");
  }
  /** Call only after the core collector's fenced reachability validation. */
  async delete(address: ObjectAddress) {
    const key = this.key(address);
    this.verified.delete(key);
    await this.bucket.delete(key);
  }
}
