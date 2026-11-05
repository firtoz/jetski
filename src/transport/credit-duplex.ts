import { Readable, Writable } from "node:stream";

export interface ExecDuplexWire {
  stdout: AsyncIterable<Uint8Array>;
  write(bytes: Uint8Array): void;
  end(): void;
  wait(): Promise<number>;
  close(): void;
}
const MAGIC = Buffer.from("JSKIIO1\n"),
  CHUNK = 16384,
  WINDOW = 65536;
const DATA = 0,
  ACK = 1,
  FIN = 2,
  EXIT = 3;
function frame(kind: number, body: Uint8Array = Buffer.alloc(0)) {
  const header = Buffer.alloc(5);
  header[0] = kind;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}
/** Shared credit bridge over a trusted host relay. SDK queues cannot outrun the
 * bounded protocol windows, even when its public API offers no drain callback. */
export function creditDuplex(exec: ExecDuplexWire) {
  let pending = Buffer.alloc(0),
    banner = false,
    ended = false,
    failed: Error | undefined;
  let exit: number | undefined,
    buffered = 0;
  const outputQueue: Uint8Array[] = [];
  let notify: (() => void) | undefined;
  let acknowledgement:
    | { bytes: number; resolve: () => void; reject: (e: Error) => void }
    | undefined;
  const fail = (error: unknown) => {
    if (failed) return;
    failed =
      error instanceof Error ? error : Error("SDK credit transport failed");
    acknowledgement?.reject(failed);
    acknowledgement = undefined;
    notify?.();
    exec.close();
  };
  const pump = (async () => {
    try {
      for await (const chunk of exec.stdout) {
        pending = Buffer.concat([pending, chunk]);
        if (pending.length > WINDOW + CHUNK + 64)
          throw Error("SDK relay parse bound");
        if (!banner) {
          if (pending.length < MAGIC.length) continue;
          if (!pending.subarray(0, MAGIC.length).equals(MAGIC))
            throw Error("Invalid SDK relay version");
          pending = pending.subarray(MAGIC.length);
          banner = true;
        }
        while (pending.length >= 5) {
          const kind = pending[0],
            length = pending.readUInt32BE(1);
          if (length > CHUNK) throw Error("SDK relay frame bound");
          if (pending.length < 5 + length) break;
          const body = Buffer.from(pending.subarray(5, 5 + length));
          pending = pending.subarray(5 + length);
          if (kind === DATA && length > 0 && exit === undefined) {
            buffered += length;
            if (buffered > WINDOW)
              throw Error("SDK relay output credit exceeded");
            outputQueue.push(body);
            notify?.();
          } else if (
            kind === ACK &&
            length === 4 &&
            acknowledgement &&
            body.readUInt32BE(0) === acknowledgement.bytes
          ) {
            acknowledgement.resolve();
            acknowledgement = undefined;
          } else if (kind === EXIT && length === 4 && exit === undefined) {
            exit = body.readInt32BE(0);
            acknowledgement?.reject(
              Error("Child exited before input acknowledgement"),
            );
            acknowledgement = undefined;
            exec.end();
          } else throw Error("Invalid SDK relay receipt");
        }
      }
      if (pending.length || !banner || exit === undefined)
        throw Error("SDK relay closed without receipt");
    } catch (error) {
      fail(error);
      throw error;
    } finally {
      ended = true;
      notify?.();
    }
  })();
  void pump.catch(() => {});
  const input = new Writable({
    write(chunk, _encoding, callback) {
      void (async () => {
        for (let offset = 0; offset < chunk.length; offset += CHUNK) {
          if (failed) throw failed;
          const bytes = chunk.subarray(offset, offset + CHUNK);
          await new Promise<void>((resolve, reject) => {
            acknowledgement = { bytes: bytes.length, resolve, reject };
            try {
              exec.write(frame(DATA, bytes));
            } catch (error) {
              fail(error);
            }
          });
        }
      })().then(
        () => callback(),
        (error) => callback(error),
      );
    },
    final(callback) {
      try {
        exec.write(frame(FIN));
        callback();
      } catch (error) {
        callback(
          error instanceof Error ? error : Error("SDK relay close failed"),
        );
      }
    },
  });
  const output = Readable.from(
    (async function* () {
      while (true) {
        if (failed) throw failed;
        const body = outputQueue.shift();
        if (body) {
          buffered -= body.length;
          const credit = Buffer.alloc(4);
          credit.writeUInt32BE(body.length);
          if (exit === undefined) exec.write(frame(ACK, credit));
          yield body;
        } else if (ended) return;
        else
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
      }
    })(),
    { objectMode: false, highWaterMark: CHUNK },
  );
  const closed = Promise.all([exec.wait(), pump]).then(([code]) => {
    if (code !== 0 || exit === undefined)
      throw Error("SDK relay exit uncertain");
    return exit;
  });
  void closed.catch(fail);
  return {
    input,
    output,
    closed,
    terminate: () => {
      fail(Error("SDK relay terminated"));
      input.destroy();
      output.destroy();
    },
  };
}
