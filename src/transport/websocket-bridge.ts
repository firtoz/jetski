import type { HostConnection } from "../core/host-stream.js";
import {
  clientWebSocketFrame,
  readWebSocketEvents,
  WEBSOCKET_MESSAGE_LIMIT,
} from "./websocket-frames.js";

export interface WebSocketPeer {
  /** Must apply backpressure or reject rather than retain unbounded messages. */
  send(data: string | Uint8Array): void | Promise<void>;
  close(code?: number, reason?: string): void;
  listen(handlers: {
    message(data: string | Uint8Array): void;
    close(code: number, reason: string): void;
    error(): void;
  }): () => void;
}
const QUEUE_BYTES = 2 * WEBSOCKET_MESSAGE_LIMIT;
const QUEUE_FRAMES = 256;
const CLOSE_MS = 5000;

/** Bridge an accepted platform socket to an upgraded, authorized host connection.
 * Never retries bytes. Resolves only after a close exchange AND host completion.
 * Callers retain authentication, expiry/revocation and platform output bounds. */
export async function bridgeWebSocket(
  connection: HostConnection,
  peer: WebSocketPeer,
  signal: AbortSignal,
): Promise<void> {
  const cancelled = new AbortController();
  const lifetime = AbortSignal.any([signal, cancelled.signal]);
  let closing = false,
    stopped = false,
    remoteClosed = false;
  let queuedBytes = 0,
    queuedFrames = 0;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve();
  let failure: unknown;
  const fail = (error: unknown) => {
    if (stopped) return;
    stopped = true;
    failure = error;
    cancelled.abort(error);
    connection.abort();
    try {
      peer.close(1011, "Preview connection ended");
    } catch {}
  };
  const lifetimeTimer = setTimeout(
    () => fail(Error("WebSocket lifetime exceeded")),
    3600000,
  );
  const abort = () => fail(lifetime.reason);
  lifetime.addEventListener("abort", abort, { once: true });
  const wait = async <T>(work: Promise<T>): Promise<T> => {
    if (lifetime.aborted) {
      void work.catch(() => {});
      lifetime.throwIfAborted();
    }
    let cancel = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      cancel = () => reject(lifetime.reason);
      lifetime.addEventListener("abort", cancel, { once: true });
    });
    try {
      return await Promise.race([work, interrupted]);
    } finally {
      lifetime.removeEventListener("abort", cancel);
    }
  };
  const enqueue = (opcode: 1 | 2 | 8 | 9 | 10, bytes: Uint8Array) => {
    if (stopped) throw Error("WebSocket bridge stopped");
    if (
      queuedBytes + bytes.length + 14 > QUEUE_BYTES ||
      queuedFrames >= QUEUE_FRAMES
    )
      throw Error("WebSocket input queue limit exceeded");
    const frame = clientWebSocketFrame(opcode, bytes);
    queuedBytes += frame.length;
    queuedFrames++;
    queue = queue
      .then(async () => {
        for (let at = 0; at < frame.length; at += 16384) {
          lifetime.throwIfAborted();
          await wait(connection.send(frame.subarray(at, at + 16384)));
        }
      })
      .finally(() => {
        queuedBytes -= frame.length;
        queuedFrames--;
      });
    void queue.catch(fail);
  };
  const startClosing = () => {
    closing = true;
    closeTimer ??= setTimeout(
      () => fail(Error("WebSocket close timed out")),
      CLOSE_MS,
    );
  };
  let detach = () => {};
  void connection.completed.catch(fail);
  try {
    lifetime.throwIfAborted();
    detach = peer.listen({
      message(data) {
        if (closing || stopped) return;
        try {
          if (data.length > WEBSOCKET_MESSAGE_LIMIT)
            throw Error("WebSocket message limit exceeded");
          if (typeof data === "string")
            enqueue(1, new TextEncoder().encode(data));
          else enqueue(2, data);
        } catch (error) {
          fail(error);
        }
      },
      close(code, reason) {
        if (closing || stopped) return;
        try {
          if (
            !Number.isInteger(code) ||
            code < 0 ||
            code > 65535 ||
            (code === 1005 && reason !== "")
          )
            throw Error("Invalid platform close code");
          const text = new TextEncoder().encode(reason);
          const bytes = new Uint8Array(code === 1005 ? 0 : 2 + text.length);
          if (bytes.length) {
            new DataView(bytes.buffer).setUint16(0, code);
            bytes.set(text, 2);
          }
          enqueue(8, bytes);
          startClosing();
        } catch (error) {
          fail(error);
        }
      },
      error() {
        fail(Error("Platform WebSocket failed"));
      },
    });
    const iterator = readWebSocketEvents(connection.output)[
      Symbol.asyncIterator
    ]();
    for (;;) {
      const next = await wait(iterator.next());
      if (next.done) break;
      const event = next.value;
      if (event.kind === "close") {
        remoteClosed = true;
        if (!closing) {
          enqueue(8, event.bytes);
          startClosing();
        }
        await wait(queue);
        peer.close(event.code, event.reason);
        await wait(connection.end());
      } else if (event.kind === "ping") {
        if (!closing) enqueue(10, event.bytes);
      } else if (event.kind === "text" || event.kind === "binary") {
        if (!closing)
          await wait(
            Promise.resolve(
              peer.send(event.kind === "text" ? event.text : event.bytes),
            ),
          );
      }
    }
    if (!remoteClosed) throw Error("WebSocket close not observed");
    await wait(queue);
    await wait(connection.completed);
    if (failure) throw failure;
    stopped = true;
  } catch (error) {
    fail(error);
    throw error;
  } finally {
    clearTimeout(closeTimer);
    clearTimeout(lifetimeTimer);
    lifetime.removeEventListener("abort", abort);
    detach();
  }
}
