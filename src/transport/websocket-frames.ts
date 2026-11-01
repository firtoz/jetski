import type { ByteStream } from "../core/contracts.js";

export const WEBSOCKET_MESSAGE_LIMIT = 8 * 1024 * 1024;
const FRAGMENT_LIMIT = 4096;
export type WebSocketEvent =
  | { kind: "text"; text: string }
  | { kind: "binary" | "ping" | "pong"; bytes: Uint8Array }
  | {
      kind: "close";
      bytes: Uint8Array;
      code: number | undefined;
      reason: string;
    };

function closePayload(bytes: Uint8Array) {
  if (bytes.length > 125 || bytes.length === 1)
    throw Error("Invalid WebSocket close payload");
  if (!bytes.length) return { code: undefined, reason: "" };
  const code = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint16(0);
  if (
    !(code >= 3000 && code <= 4999) &&
    !(code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code))
  )
    throw Error("Invalid WebSocket close code");
  return {
    code,
    reason: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(2),
    ),
  };
}

class FrameReader {
  private bytes: Uint8Array = new Uint8Array();
  private at = 0;
  private readonly iterator: AsyncIterator<Uint8Array>;
  constructor(source: ByteStream) {
    this.iterator = source[Symbol.asyncIterator]();
  }
  async exact(length: number, eof = false): Promise<Uint8Array | undefined> {
    const output = new Uint8Array(length);
    let copied = 0;
    while (copied < length) {
      if (this.at === this.bytes.length) {
        const next = await this.iterator.next();
        if (next.done) {
          if (eof && copied === 0) return undefined;
          throw Error("Truncated WebSocket frame");
        }
        if (
          !(next.value instanceof Uint8Array) ||
          next.value.length > 2 * 1024 * 1024
        )
          throw Error("Invalid WebSocket transport chunk");
        this.bytes = next.value;
        this.at = 0;
      }
      const count = Math.min(length - copied, this.bytes.length - this.at);
      output.set(this.bytes.subarray(this.at, this.at + count), copied);
      this.at += count;
      copied += count;
    }
    return output;
  }
  async required(length: number): Promise<Uint8Array> {
    const bytes = await this.exact(length);
    if (!bytes) throw Error("Truncated WebSocket frame");
    return bytes;
  }
}

/** Decode server frames only: no masking or extensions. Retained message memory
 * and fragment counts are bounded; UTF-8 is validated across whole messages.
 * A close event must be answered before continuing iteration to transport EOF. */
export async function* readWebSocketEvents(
  source: ByteStream,
): AsyncGenerator<WebSocketEvent> {
  const reader = new FrameReader(source);
  let opcode: number | undefined,
    total = 0;
  let fragments: Uint8Array[] = [];
  for (;;) {
    const header = await reader.exact(2, true);
    if (!header) throw Error("WebSocket ended without close");
    const first = header[0] ?? 0,
      second = header[1] ?? 0;
    const final = Boolean(first & 128),
      op = first & 15;
    if (
      (first & 112) !== 0 ||
      (second & 128) !== 0 ||
      ![0, 1, 2, 8, 9, 10].includes(op)
    )
      throw Error("Invalid server WebSocket frame");
    let length = second & 127;
    if (op >= 8 && (!final || length > 125))
      throw Error("Invalid WebSocket control frame");
    if (length === 126) {
      const ext = await reader.required(2);
      length = new DataView(ext.buffer).getUint16(0);
      if (length < 126) throw Error("Noncanonical WebSocket length");
    } else if (length === 127) {
      const ext = await reader.required(8),
        view = new DataView(ext.buffer);
      if (view.getUint32(0) !== 0)
        throw Error("WebSocket message limit exceeded");
      length = view.getUint32(4);
      if (length < 65536) throw Error("Noncanonical WebSocket length");
    }
    if (length > WEBSOCKET_MESSAGE_LIMIT)
      throw Error("WebSocket message limit exceeded");
    if (op < 8) {
      if (op === 0 && opcode === undefined)
        throw Error("Unexpected WebSocket continuation");
      if (op !== 0 && opcode !== undefined)
        throw Error("Interleaved WebSocket message");
      if (op !== 0) opcode = op;
      total += length;
      if (total > WEBSOCKET_MESSAGE_LIMIT || fragments.length >= FRAGMENT_LIMIT)
        throw Error("WebSocket message limit exceeded");
    }
    const bytes = await reader.required(length);
    if (op === 8) {
      yield { kind: "close", bytes, ...closePayload(bytes) };
      if (await reader.exact(1, true))
        throw Error("WebSocket bytes after close");
      return;
    }
    if (op === 9 || op === 10) {
      yield { kind: op === 9 ? "ping" : "pong", bytes };
      continue;
    }
    fragments.push(bytes);
    if (!final) continue;
    const message = new Uint8Array(total);
    let at = 0;
    for (const fragment of fragments) {
      message.set(fragment, at);
      at += fragment.length;
    }
    if (opcode === 1)
      yield {
        kind: "text",
        text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          message,
        ),
      };
    else yield { kind: "binary", bytes: message };
    opcode = undefined;
    total = 0;
    fragments = [];
  }
}

/** Produce a single final client frame with an unpredictable fresh mask. */
export function clientWebSocketFrame(
  opcode: 1 | 2 | 8 | 9 | 10,
  payload: Uint8Array,
): Uint8Array {
  if (
    ![1, 2, 8, 9, 10].includes(opcode) ||
    payload.length > WEBSOCKET_MESSAGE_LIMIT
  )
    throw Error("Invalid WebSocket payload");
  if (opcode >= 8 && payload.length > 125)
    throw Error("Invalid WebSocket control payload");
  if (opcode === 8) closePayload(payload);
  if (opcode === 1)
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(payload);
  let extra = 0;
  if (payload.length >= 65536) extra = 8;
  else if (payload.length >= 126) extra = 2;
  const frame = new Uint8Array(2 + extra + 4 + payload.length),
    view = new DataView(frame.buffer);
  frame[0] = 128 | opcode;
  if (extra === 8) {
    frame[1] = 255;
    view.setUint32(6, payload.length);
  } else if (extra === 2) {
    frame[1] = 254;
    view.setUint16(2, payload.length);
  } else frame[1] = 128 | payload.length;
  const mask = crypto.getRandomValues(new Uint8Array(4));
  frame.set(mask, 2 + extra);
  for (let i = 0; i < payload.length; i++)
    frame[6 + extra + i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
  return frame;
}
