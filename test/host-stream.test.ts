import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { encodeStreamFrame as encode } from "../src/core/stream-protocol.js";
import { HostTransportError } from "../src/core/transport.js";
import { attachHostStream } from "../src/transport/host-stream.js";

function fixture() {
  const input = new PassThrough(),
    output = new PassThrough();
  const received: Buffer[] = [];
  input.on("data", (bytes: Buffer) => received.push(Buffer.from(bytes)));
  let close!: (code: number | null) => void;
  const closed = new Promise<number | null>((resolve) => {
    close = resolve;
  });
  let terminated = 0;
  return {
    input,
    output,
    received,
    close,
    get terminated() {
      return terminated;
    },
    wire: {
      input,
      output,
      closed,
      terminate: () => {
        terminated++;
        close(null);
      },
    },
  };
}
const ready = encode({ kind: "ready" }),
  fin = encode({ kind: "fin" });
const data = Uint8Array.from({ length: 16384 }, (_, i) => i % 251);

test("duplex host bridge preserves binary data and requires verified closure", async () => {
  const f = fixture();
  f.output.write(ready);
  const connection = await attachHostStream(f.wire, new Uint8Array([1, 2, 3]));
  await connection.send(data);
  await connection.end();
  await assert.rejects(connection.send(data), /unavailable/);
  const result: Uint8Array[] = [];
  const reading = (async () => {
    for await (const part of connection.output) result.push(part);
  })();
  f.output.end(Buffer.concat([encode({ kind: "data", bytes: data }), fin]));
  f.close(0);
  await reading;
  await connection.completed;
  assert.deepEqual(Buffer.concat(result), Buffer.from(data));
  assert.deepEqual(
    Buffer.concat(f.received),
    Buffer.concat([
      new Uint8Array([1, 2, 3]),
      encode({ kind: "data", bytes: data }),
      fin,
    ]),
  );
  assert.equal(f.terminated, 0);
  connection.abort();
  assert.equal(f.terminated, 0);
  await assert.rejects(async () => {
    for await (const _ of connection.output) {
    }
  }, /already consumed/);
});

test("malformed readiness, premature EOF and abort never reopen the transport", async () => {
  for (const bytes of [fin, new Uint8Array(), new Uint8Array([82, 0])]) {
    const f = fixture();
    f.output.end(bytes);
    f.close(0);
    await assert.rejects(
      attachHostStream(f.wire, new Uint8Array([1])),
      HostTransportError,
    );
    assert.equal(f.terminated, 1);
  }
  const f = fixture(),
    controller = new AbortController();
  f.output.write(ready);
  const connection = await attachHostStream(
    f.wire,
    new Uint8Array([1]),
    controller.signal,
  );
  controller.abort();
  await assert.rejects(connection.completed, HostTransportError);
  await assert.rejects(connection.send(data), HostTransportError);
  assert.equal(f.terminated, 1);
});

test("FIN without input closure, nonzero exit and truncated output stay uncertain", async () => {
  for (const scenario of [
    "input-open",
    "exit",
    "truncated",
    "abandon",
  ] as const) {
    const f = fixture();
    f.output.write(ready);
    const connection = await attachHostStream(f.wire, new Uint8Array([1]));
    if (scenario !== "input-open") await connection.end();
    f.output.end(
      Buffer.concat([
        encode({ kind: "data", bytes: data }),
        scenario === "truncated" ? new Uint8Array() : fin,
      ]),
    );
    f.close(scenario === "exit" ? 1 : 0);
    if (scenario === "abandon") {
      for await (const _ of connection.output) break;
    } else if (scenario === "input-open" || scenario === "exit") {
      try {
        for await (const _ of connection.output) {
        }
      } catch (error) {
        assert.ok(error instanceof HostTransportError);
      }
    } else {
      await assert.rejects(async () => {
        for await (const _ of connection.output) {
        }
      }, HostTransportError);
    }
    await assert.rejects(connection.completed, HostTransportError);
    assert.equal(f.terminated, 1);
  }
});

test("backpressure admits one bounded write and forbids concurrent input", async () => {
  const f = fixture();
  let calls = 0;
  const pending: Array<() => void> = [];
  const input = new Writable({
    write(_bytes, _encoding, done) {
      if (++calls === 1) done();
      else pending.push(done);
    },
  });
  f.output.write(ready);
  const connection = await attachHostStream(
    { ...f.wire, input },
    new Uint8Array([1]),
  );
  await assert.rejects(connection.send(new Uint8Array(16385)), /length/);
  const sending = connection.send(data);
  await assert.rejects(connection.send(data), /unavailable/);
  await assert.rejects(connection.end(), /unavailable/);
  assert.equal(pending.length, 1);
  pending.shift()!();
  await sending;
  const ending = connection.end();
  pending.shift()!();
  await ending;
  f.output.end(fin);
  f.close(0);
  for await (const _ of connection.output) {
  }
  await connection.completed;
  assert.equal(calls, 3);
});

test("remote half-close reaches the reader while uploads can still continue", async () => {
  const f = fixture();
  f.output.write(ready);
  const connection = await attachHostStream(f.wire, new Uint8Array([1]));
  f.output.write(Buffer.concat([encode({ kind: "data", bytes: data }), fin]));
  const received: Uint8Array[] = [];
  for await (const bytes of connection.output) received.push(bytes);
  assert.deepEqual(Buffer.concat(received), Buffer.from(data));
  await connection.send(data);
  await connection.end();
  f.output.end();
  f.close(0);
  await connection.completed;
  assert.equal(f.terminated, 0);
});
