/** Node stream bridge, separate from portable core and provider credentials. */
import type { Readable, Writable } from "node:stream";
import type { HostConnection } from "../core/host-stream.js";
import { encodeStreamFrame, StreamDecoder } from "../core/stream-protocol.js";
import { HostTransportError } from "../core/transport.js";

export type StreamWire = {
  input: Writable;
  output: Readable;
  closed: Promise<number | null>;
  terminate(): void;
};
export async function attachHostStream(
  wire: StreamWire,
  header: Uint8Array,
  signal?: AbortSignal,
): Promise<HostConnection> {
  let failure: HostTransportError | undefined;
  let resolveDone!: () => void, rejectDone!: (error: Error) => void;
  let inputEnded = false,
    writing = false,
    consumed = false,
    finished = false;
  const completed = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // Admission can fail before a caller receives the connection.
  void completed.catch(() => {});
  const cleanup = () => {
    clearTimeout(admission);
    clearTimeout(lifetime);
    signal?.removeEventListener("abort", abort);
  };
  const fail = (message: string) => {
    if (failure || finished) return;
    failure = new HostTransportError(message);
    cleanup();
    wire.input.destroy(failure);
    wire.output.destroy(failure);
    wire.terminate();
    rejectDone(failure);
  };
  const abort = () =>
    fail("Host stream interrupted; delivery and cleanup unknown");
  const admission = setTimeout(
    () => fail("Host stream admission timed out"),
    30_000,
  );
  const lifetime = setTimeout(
    () => fail("Host stream lifetime exceeded"),
    3600_000,
  );
  wire.input.on("error", () => fail("Host stream input failed"));
  wire.output.on("error", () => fail("Host stream output failed"));
  const closed = wire.closed.then(
    (code) => {
      if (code !== 0)
        fail("Host stream failed; inspect durable receipt before further work");
      return code;
    },
    () => {
      fail("Host stream transport failed");
      return null;
    },
  );
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  async function write(bytes: Uint8Array) {
    if (failure) throw failure;
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        fail("Host stream input backpressure deadline");
        reject(failure);
      }, 5000);
      wire.input.write(bytes, (error) => {
        clearTimeout(deadline);
        if (error) {
          fail("Host stream input delivery unknown");
          reject(failure);
        } else resolve();
      });
    });
    if (failure) throw failure;
  }
  const decoder = new StreamDecoder(true);
  async function* frames() {
    for await (const bytes of wire.output) {
      for (const frame of decoder.feed(bytes)) yield frame;
    }
    decoder.finish();
  }
  const incoming = frames();
  try {
    await write(header);
    const ready = await incoming.next();
    if (failure) throw failure;
    if (ready.done || ready.value.kind !== "ready")
      throw Error("Missing relay readiness");
    clearTimeout(admission);
  } catch {
    fail("Host stream admission unknown; never replay automatically");
    throw failure;
  }
  async function send(bytes?: Uint8Array) {
    if (failure) throw failure;
    if (inputEnded || writing || finished)
      throw Error("Stream input unavailable");
    const frame = encodeStreamFrame(
      bytes === undefined ? { kind: "fin" } : { kind: "data", bytes },
    );
    writing = true;
    try {
      await write(frame);
      if (bytes === undefined) {
        inputEnded = true;
        wire.input.end();
      }
    } finally {
      writing = false;
    }
  }
  async function finishConnection() {
    try {
      // FIN closes only the output direction. Continue validating framing and
      // host termination while input may still be flowing in the other direction.
      for await (const _ of incoming) throw Error("Data after stream FIN");
      if (!inputEnded || (await closed) !== 0 || failure)
        throw Error("Host stream completion unknown");
      finished = true;
      cleanup();
      resolveDone();
    } catch {
      fail("Host stream completion unknown");
    }
  }
  const output = {
    async *[Symbol.asyncIterator]() {
      if (consumed) throw Error("Host stream output already consumed");
      consumed = true;
      let fin = false;
      try {
        for (;;) {
          const next = await incoming.next();
          if (next.done) throw Error("Missing stream FIN");
          const frame = next.value;
          if (frame.kind === "data") yield frame.bytes;
          else if (frame.kind === "fin") {
            fin = true;
            void finishConnection();
            return;
          } else throw Error("Duplicate stream readiness");
        }
      } catch {
        fail("Host stream completion unknown");
        throw failure;
      } finally {
        if (!fin) abort();
      }
    },
  };
  return { output, send, end: () => send(), abort, completed };
}
