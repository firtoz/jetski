import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  type ByteStream,
  type CheckpointStore,
  DEFAULTS,
  identifier,
  type ObjectAddress,
  type ObjectInfo,
  type Scope,
} from "../core/contracts.js";

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Private control-plane directory; never mount it into a workload. A permanent
 * reservation prevents reusing an object identity after deletion or failed put.
 * An interrupted upload can leak a reservation, but cannot replace acknowledged bytes. */
export class LocalCheckpointStore implements CheckpointStore {
  readonly verificationConcurrency = DEFAULTS.verificationConcurrency;
  readonly transferConcurrency = DEFAULTS.transferConcurrency;
  private readonly root: string;
  constructor(
    root: string,
    private readonly maxBytes = DEFAULTS.maxObjectBytes,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new Error("Invalid object bound");
    this.root = resolve(root);
  }
  private directory(scope: Scope) {
    return join(this.root, identifier(scope.owner), identifier(scope.sandbox));
  }
  private path(address: ObjectAddress) {
    return join(this.directory(address), `${identifier(address.id)}.blob`);
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
      throw new Error("Invalid object metadata");
    const destination = this.path(address);
    const dir = this.directory(address);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await this.syncDirectory(dirname(this.root));
    await this.syncDirectory(this.root);
    await this.syncDirectory(dirname(dir));
    const reservation = await open(`${destination}.reserved`, "wx", 0o600);
    await reservation.sync();
    await reservation.close();
    await this.syncDirectory(dir);
    const temporary = join(dir, `${address.id}.${randomUUID()}.partial`);
    const file = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      for await (const chunk of source) {
        bytes += chunk.byteLength;
        if (bytes > expected.bytes)
          throw new Error("Object exceeds declared length");
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const result = await file.write(
            chunk,
            offset,
            chunk.byteLength - offset,
          );
          if (!result.bytesWritten) throw new Error("Short object write");
          offset += result.bytesWritten;
        }
      }
      if (bytes !== expected.bytes || hash.digest("hex") !== expected.sha256)
        throw new Error("Object integrity mismatch");
      await file.sync();
      await file.close();
      await rename(temporary, destination);
      await this.syncDirectory(dir);
      const verified = await this.head(address);
      if (
        !verified ||
        verified.bytes !== expected.bytes ||
        verified.sha256 !== expected.sha256
      )
        throw new Error("Publication verification failed");
      return verified;
    } catch (error) {
      await file.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
  private async syncDirectory(dir: string) {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  async head(address: ObjectAddress): Promise<ObjectInfo | undefined> {
    let file: FileHandle;
    try {
      file = await open(
        this.path(address),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > this.maxBytes)
        throw new Error("Invalid stored object");
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        hash.update(chunk);
        bytes += chunk.length;
      }
      if (bytes !== stat.size)
        throw new Error("Stored object changed during read");
      return { ...address, bytes, sha256: hash.digest("hex") };
    } finally {
      await file.close();
    }
  }
  async *read(
    address: ObjectAddress,
    range?: { start: number; endExclusive: number },
  ): ByteStream {
    const file = await open(
      this.path(address),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > this.maxBytes)
        throw new Error("Invalid stored object");
      const start = range?.start ?? 0;
      const end = range?.endExclusive ?? stat.size;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        end > stat.size
      )
        throw new Error("Invalid read range");
      if (start === end) return;
      for await (const chunk of file.createReadStream({
        start,
        end: end - 1,
        autoClose: false,
        highWaterMark: 64 * 1024,
      }))
        yield new Uint8Array(chunk);
    } finally {
      await file.close();
    }
  }
  async *list(scope: Scope): AsyncIterable<ObjectInfo> {
    identifier(scope.owner);
    identifier(scope.sandbox);
    let names: string[];
    try {
      names = await readdir(this.directory(scope));
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".blob")) continue;
      const item = await this.head({ ...scope, id: name.slice(0, -5) });
      if (!item) throw new Error("Listing changed during enumeration");
      yield item;
    }
  }
  /** Only call under the core collector's fenced sweep admission. */
  async delete(address: ObjectAddress): Promise<void> {
    try {
      await unlink(this.path(address));
      await this.syncDirectory(this.directory(address));
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
}
