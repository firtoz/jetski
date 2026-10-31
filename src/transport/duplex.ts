/** Optional Node stream adapter. Output EOF is not host completion. */
import { Duplex } from "node:stream";
import type { HostConnection } from "../core/host-stream.js";

export class HostDuplex extends Duplex {
  readonly completed: Promise<void>;
  private readonly outputIterator: AsyncIterator<Uint8Array>;
  private reading = false;
  private outputEnded = false;
  private inputEnded = false;
  private verified = false;
  private finalTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly connection: HostConnection) {
    super({ allowHalfOpen: true, autoDestroy: false, highWaterMark: 16384 });
    this.outputIterator = connection.output[Symbol.asyncIterator]();
    this.completed = connection.completed.then(
      () => {
        this.verified = true;
        clearTimeout(this.finalTimer);
      },
      () => {
        const error = Error("Host connection failed; inspect stream receipt");
        this.destroy(error);
        throw error;
      },
    );
    void this.completed.catch(() => {});
  }
  override _read() {
    if (this.reading || this.outputEnded || this.destroyed) return;
    this.reading = true;
    void (async () => {
      try {
        while (!this.destroyed) {
          const next = await this.outputIterator.next();
          if (this.destroyed) return;
          if (next.done) {
            this.outputEnded = true;
            this.push(null);
            this.awaitReceipt();
            return;
          }
          if (
            !(next.value instanceof Uint8Array) ||
            next.value.length > 2 * 1024 * 1024
          )
            throw Error("Invalid host output chunk");
          if (!this.push(next.value)) return;
        }
      } catch {
        this.destroy(Error("Host output failed; inspect stream receipt"));
      } finally {
        this.reading = false;
      }
    })();
  }
  override _write(
    bytes: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    void (async () => {
      try {
        if (bytes.length > 2 * 1024 * 1024)
          throw Error("Host input chunk exceeds bound");
        for (let offset = 0; offset < bytes.length; offset += 16384) {
          if (this.destroyed) throw Error("Host input interrupted");
          await this.connection.send(bytes.subarray(offset, offset + 16384));
        }
        callback();
      } catch {
        const error = Error("Host input failed; inspect stream receipt");
        this.destroy(error);
        callback(error);
      }
    })();
  }
  override _final(callback: (error?: Error | null) => void) {
    void this.connection.end().then(
      () => {
        this.inputEnded = true;
        this.awaitReceipt();
        callback();
      },
      () => {
        const error = Error(
          "Host input closure failed; inspect stream receipt",
        );
        this.destroy(error);
        callback(error);
      },
    );
  }
  private awaitReceipt() {
    if (
      this.inputEnded &&
      this.outputEnded &&
      !this.verified &&
      !this.finalTimer
    ) {
      this.finalTimer = setTimeout(
        () => this.destroy(Error("Host completion receipt timed out")),
        30000,
      );
    }
  }
  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ) {
    clearTimeout(this.finalTimer);
    if (!error && !this.verified && this.outputEnded && this.writableEnded) {
      // HTTP clients destroy their socket at EOF. Once both directions ended,
      // preserve the independent authenticated completion receipt before close.
      const deadline = setTimeout(() => this.connection.abort(), 30000);
      void this.completed.then(
        () => {
          clearTimeout(deadline);
          callback();
        },
        () => {
          clearTimeout(deadline);
          callback(Error("Host completion unverified"));
        },
      );
      return;
    }
    if (!this.verified) this.connection.abort();
    callback(error);
  }
}
