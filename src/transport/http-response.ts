import type { ByteStream } from "../core/contracts.js";

const HEAD_LIMIT = 32768;
const BODY_LIMIT = 64 * 1024 * 1024;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Strict, bounded HTTP/1 response framing for one Connection: close exchange.
 * This is not authentication, preview header policy, or a host completion receipt.
 * The caller must cancel its connection on any parse failure or abandoned body.
 * See RFC 9112 sections 5-7. Unsupported transfer codings fail closed. */
class Reader {
  private chunk: Uint8Array = new Uint8Array();
  private at = 0;
  private readonly source: AsyncIterator<Uint8Array>;
  constructor(source: ByteStream) {
    this.source = source[Symbol.asyncIterator]();
  }
  async take(max: number): Promise<Uint8Array | undefined> {
    while (this.at === this.chunk.length) {
      const next = await this.source.next();
      if (next.done) return undefined;
      if (
        !(next.value instanceof Uint8Array) ||
        next.value.length > 2 * 1024 * 1024
      )
        throw Error("Invalid HTTP transport chunk");
      this.chunk = next.value;
      this.at = 0;
    }
    const end = Math.min(this.chunk.length, this.at + max);
    const result = this.chunk.slice(this.at, end);
    this.at = end;
    return result;
  }
  async line(): Promise<string> {
    const bytes: number[] = [];
    while (bytes.length < HEAD_LIMIT) {
      const part = await this.take(1);
      if (!part) throw Error("Truncated HTTP line");
      const byte = part[0];
      if (byte === undefined) throw Error("Invalid HTTP byte");
      bytes.push(byte);
      if (byte === 10) {
        if (bytes.length < 2 || bytes[bytes.length - 2] !== 13)
          throw Error("HTTP requires CRLF");
        return String.fromCharCode(...bytes.slice(0, -2));
      }
    }
    throw Error("HTTP line limit exceeded");
  }
  async *exact(length: number): ByteStream {
    while (length > 0) {
      const bytes = await this.take(Math.min(length, 16384));
      if (!bytes) throw Error("Truncated HTTP body");
      length -= bytes.length;
      yield bytes;
    }
  }
  async eof(): Promise<void> {
    if (await this.take(1)) throw Error("Unexpected bytes after HTTP body");
  }
}

type Fields = Array<[string, string]>;
async function fields(
  reader: Reader,
  budget: { bytes: number },
): Promise<Fields> {
  const result: Fields = [];
  for (;;) {
    const line = await reader.line();
    budget.bytes += line.length + 2;
    if (budget.bytes > HEAD_LIMIT || result.length > 100)
      throw Error("HTTP headers limit exceeded");
    if (!line) return result;
    const colon = line.indexOf(":");
    const name = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, "");
    if (
      colon < 1 ||
      !TOKEN.test(name) ||
      /[\x00-\x08\x0a-\x1f\x7f]/.test(value)
    )
      throw Error("Invalid HTTP field");
    result.push([name.toLowerCase(), value]);
  }
}
function framing(headers: Fields) {
  const lengths = headers.filter(([name]) => name === "content-length");
  const transfers = headers.filter(([name]) => name === "transfer-encoding");
  if (
    lengths.length > 1 ||
    transfers.length > 1 ||
    (lengths.length && transfers.length)
  )
    throw Error("Ambiguous HTTP framing");
  const rawLength = lengths[0]?.[1];
  if (
    rawLength !== undefined &&
    (!/^[0-9]+$/.test(rawLength) || !Number.isSafeInteger(Number(rawLength)))
  )
    throw Error("Invalid HTTP content length");
  const coding = transfers[0]?.[1];
  if (coding !== undefined && coding.toLowerCase() !== "chunked")
    throw Error("Unsupported HTTP transfer coding");
  return {
    length: rawLength === undefined ? undefined : Number(rawLength),
    chunked: coding !== undefined,
  };
}

export async function readHttpResponse(source: ByteStream, method: string) {
  const reader = new Reader(source),
    budget = { bytes: 0 };
  let status = 0,
    headers: Fields = [];
  for (let interim = 0; interim < 9; interim++) {
    const line = await reader.line();
    budget.bytes += line.length + 2;
    const match =
      /^HTTP\/1\.[01] ([1-5][0-9]{2}) [\t\x20-\x7e\x80-\xff]*$/.exec(line);
    if (!match) throw Error("Invalid HTTP status line");
    status = Number(match[1]);
    headers = await fields(reader, budget);
    if (status === 101) throw Error("HTTP upgrade requires WebSocket adapter");
    if (status >= 200) break;
    if (
      headers.some(
        ([name]) => name === "content-length" || name === "transfer-encoding",
      )
    )
      throw Error("Invalid informational response framing");
  }
  if (status < 200) throw Error("Too many informational responses");
  const frame = framing(headers);
  if (status === 204 && (frame.length !== undefined || frame.chunked))
    throw Error("Invalid no-content response framing");
  const empty = method === "HEAD" || status === 204 || status === 304;
  if (!empty && frame.length !== undefined && frame.length > BODY_LIMIT)
    throw Error("HTTP body limit exceeded");
  async function* body(): ByteStream {
    if (!empty) {
      if (frame.chunked) {
        let total = 0;
        for (;;) {
          const line = await reader.line();
          // Extensions are bounded and syntax checked, but not interpreted.
          const match =
            /^([0-9a-fA-F]+)((?:;[ \t]*[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:=(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"(?:[\t\x20-\x21\x23-\x5b\x5d-\x7e]|\\[\t\x20-\x7e])*"))?)*)$/.exec(
              line,
            );
          if (!match) throw Error("Invalid HTTP chunk size");
          const size = Number.parseInt(match[1] ?? "", 16);
          total += size;
          if (!Number.isSafeInteger(size) || total > BODY_LIMIT)
            throw Error("HTTP body limit exceeded");
          if (size === 0) {
            const trailers = await fields(reader, budget);
            if (
              trailers.some(([name]) =>
                ["content-length", "transfer-encoding", "host"].includes(name),
              )
            )
              throw Error("Forbidden HTTP trailer");
            break;
          }
          yield* reader.exact(size);
          if ((await reader.line()) !== "")
            throw Error("Invalid HTTP chunk terminator");
        }
      } else if (frame.length !== undefined) {
        yield* reader.exact(frame.length);
      } else {
        let total = 0;
        for (;;) {
          const bytes = await reader.take(16384);
          if (!bytes) return;
          total += bytes.length;
          if (total > BODY_LIMIT) throw Error("HTTP body limit exceeded");
          yield bytes;
        }
      }
    }
    await reader.eof();
  }
  return { status, headers, body: body() };
}

/** Preserve bytes coalesced with the upgrade headers for the frame decoder. */
export async function readHttpUpgrade(source: ByteStream) {
  const reader = new Reader(source);
  const line = await reader.line();
  if (!/^HTTP\/1\.1 101 [\t\x20-\x7e\x80-\xff]*$/.test(line))
    throw Error("WebSocket upgrade refused");
  const headers = await fields(reader, { bytes: line.length + 2 });
  if (
    headers.some(
      ([name]) => name === "content-length" || name === "transfer-encoding",
    )
  )
    throw Error("Invalid upgrade framing");
  async function* remaining(): ByteStream {
    for (;;) {
      const bytes = await reader.take(16384);
      if (!bytes) return;
      yield bytes;
    }
  }
  return { headers, output: remaining() };
}
