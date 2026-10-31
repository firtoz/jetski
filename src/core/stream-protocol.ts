/** Workload relay framing; transport EOF alone never proves stream completion. */
export const STREAM_MAGIC = "JETSKI-STREAM/1\n";
export const STREAM_DATA_BYTES = 16384;
export const STREAM_CHUNK_BYTES = 1024 * 1024;
export type StreamFrame =
  | { kind: "ready" }
  | { kind: "fin" }
  | { kind: "data"; bytes: Uint8Array };

export function encodeStreamFrame(frame: StreamFrame): Uint8Array {
  const length = frame.kind === "data" ? frame.bytes.byteLength : 0;
  if (frame.kind === "data" && (!length || length > STREAM_DATA_BYTES))
    throw Error("Invalid stream data length");
  const result = new Uint8Array(5 + length);
  result[0] = { ready: 82, data: 68, fin: 70 }[frame.kind];
  new DataView(result.buffer).setUint32(1, length);
  if (frame.kind === "data") result.set(frame.bytes, 5);
  return result;
}

/** Fixed-size pending frame, immutable yielded data, strict direction and FINs.
 * Drain each feed iterator before the next feed. A failed decoder cannot resume. */
export class StreamDecoder {
  private readonly pending = new Uint8Array(STREAM_DATA_BYTES + 5);
  private used = 0;
  private ready: boolean;
  private ended = false;
  private failed = false;
  private feeding = false;
  constructor(private readonly output: boolean) {
    this.ready = !output;
  }
  *feed(chunk: Uint8Array): Generator<StreamFrame> {
    if (this.failed || this.feeding) throw Error("Stream decoder unavailable");
    this.feeding = true;
    let drained = false;
    try {
      if (
        !(chunk instanceof Uint8Array) ||
        chunk.byteLength > STREAM_CHUNK_BYTES
      )
        throw Error("Stream chunk bound exceeded");
      let at = 0;
      while (at < chunk.byteLength) {
        if (this.ended) throw Error("Stream data after FIN");
        const target = this.used < 5 ? 5 : this.length() + 5;
        const take = Math.min(target - this.used, chunk.byteLength - at);
        this.pending.set(chunk.subarray(at, at + take), this.used);
        this.used += take;
        at += take;
        if (this.used < 5) continue;
        const tag = this.pending[0],
          length = this.length();
        if (length > STREAM_DATA_BYTES)
          throw Error("Stream frame bound exceeded");
        switch (tag) {
          case 82:
            if (!this.output || this.ready || length)
              throw Error("Invalid stream ready frame");
            break;
          case 68:
            if (!this.ready || !length)
              throw Error("Invalid stream data frame");
            break;
          case 70:
            if (!this.ready || length) throw Error("Invalid stream FIN");
            break;
          default:
            throw Error("Invalid stream tag");
        }
        if (this.used < length + 5) continue;
        this.used = 0;
        if (tag === 82) {
          this.ready = true;
          yield { kind: "ready" };
        } else if (tag === 70) {
          this.ended = true;
          yield { kind: "fin" };
        } else {
          yield { kind: "data", bytes: this.pending.slice(5, length + 5) };
        }
      }
      drained = true;
    } finally {
      this.feeding = false;
      if (!drained) this.failed = true;
    }
  }
  finish(): void {
    if (this.failed || this.feeding || this.used || !this.ended) {
      this.failed = true;
      throw Error("Stream completion unknown");
    }
  }
  private length(): number {
    return new DataView(this.pending.buffer).getUint32(1);
  }
}
