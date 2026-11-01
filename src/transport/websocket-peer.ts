import type { WebSocketPeer } from "./websocket-bridge.js";
import { WEBSOCKET_MESSAGE_LIMIT } from "./websocket-frames.js";

export interface PlatformWebSocket {
  binaryType: string;
  readonly bufferedAmount?: number;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, handler: (event: Event) => void): void;
  removeEventListener(type: string, handler: (event: Event) => void): void;
}
export const WEBSOCKET_OUTPUT_BYTES = 64 * 1024 * 1024;
export const WEBSOCKET_OUTPUT_MESSAGES = 65536;

/** Adapter for already accepted event-based sockets. No implicit accept or auth.
 * Cumulative output bounds apply even where bufferedAmount is unavailable.
 * Reaching a bound rejects before sending; the bridge then aborts the stream. */
export function platformWebSocketPeer(
  socket: PlatformWebSocket,
): WebSocketPeer {
  socket.binaryType = "arraybuffer";
  if (socket.binaryType !== "arraybuffer")
    throw Error("Binary socket mode unavailable");
  let outputBytes = 0,
    outputMessages = 0,
    listening = false;
  return {
    send(data) {
      if (data.length > WEBSOCKET_MESSAGE_LIMIT)
        throw Error("WebSocket output message limit exceeded");
      const bytes =
        typeof data === "string"
          ? new TextEncoder().encode(data).length
          : data.byteLength;
      if (
        bytes > WEBSOCKET_MESSAGE_LIMIT ||
        outputBytes + bytes > WEBSOCKET_OUTPUT_BYTES ||
        outputMessages >= WEBSOCKET_OUTPUT_MESSAGES
      )
        throw Error("WebSocket cumulative output limit exceeded");
      const buffered = socket.bufferedAmount;
      if (
        buffered !== undefined &&
        (!Number.isSafeInteger(buffered) ||
          buffered < 0 ||
          buffered + bytes > WEBSOCKET_MESSAGE_LIMIT)
      )
        throw Error("WebSocket output buffer limit exceeded");
      // Account before the call: a thrown send can have an uncertain outcome.
      outputBytes += bytes;
      outputMessages++;
      socket.send(typeof data === "string" ? data : data.slice().buffer);
    },
    close: (code, reason) => socket.close(code, reason),
    listen(handlers) {
      if (listening) throw Error("WebSocket peer already attached");
      listening = true;
      const message = (event: Event) => {
        if (!("data" in event)) {
          handlers.error();
          return;
        }
        const data = event.data;
        if (typeof data === "string") handlers.message(data);
        else if (data instanceof ArrayBuffer)
          handlers.message(new Uint8Array(data));
        else handlers.error();
      };
      const close = (event: Event) => {
        if (
          !("code" in event) ||
          typeof event.code !== "number" ||
          !("reason" in event) ||
          typeof event.reason !== "string"
        ) {
          handlers.error();
          return;
        }
        handlers.close(event.code, event.reason);
      };
      const error = () => handlers.error();
      socket.addEventListener("message", message);
      socket.addEventListener("close", close);
      socket.addEventListener("error", error);
      return () => {
        socket.removeEventListener("message", message);
        socket.removeEventListener("close", close);
        socket.removeEventListener("error", error);
        // One attachment for the socket lifetime, including after detach.
      };
    },
  };
}
