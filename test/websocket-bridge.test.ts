import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostConnection } from "../src/core/host-stream.js";
import {
  bridgeWebSocket,
  type WebSocketPeer,
} from "../src/transport/websocket-bridge.js";

function fixture(raw: number[], receiptFails = false) {
  let handlers: Parameters<WebSocketPeer["listen"]>[0] | undefined;
  const sent: Uint8Array[] = [],
    delivered: Array<string | Uint8Array> = [],
    closes: Array<number | undefined> = [];
  let aborted = 0,
    detached = 0,
    ended = 0;
  let finish = () => {};
  let rejectReceipt = (_e: Error) => {};
  const completed = new Promise<void>((resolve, reject) => {
    finish = resolve;
    rejectReceipt = reject;
  });
  const connection: HostConnection = {
    output: (async function* () {
      yield Uint8Array.from(raw);
    })(),
    async send(bytes) {
      sent.push(bytes.slice());
    },
    async end() {
      ended++;
      if (receiptFails) rejectReceipt(Error("receipt failed"));
      else finish();
    },
    abort() {
      aborted++;
      finish();
    },
    completed,
  };
  const peer: WebSocketPeer = {
    send(data) {
      delivered.push(data);
    },
    close(code) {
      closes.push(code);
    },
    listen(h) {
      handlers = h;
      return () => {
        detached++;
      };
    },
  };
  return {
    connection,
    peer,
    sent,
    delivered,
    closes,
    emit: (data: string | Uint8Array) => handlers?.message(data),
    close: (code: number, reason: string) => handlers?.close(code, reason),
    counts: () => ({ aborted, detached, ended }),
  };
}
function unmask(frame: Uint8Array) {
  assert.ok((frame[1] ?? 0) & 128);
  return Uint8Array.from(
    frame.subarray(6),
    (b, i) => b ^ (frame[2 + (i % 4)] ?? 0),
  );
}
test("bridge sends masked input/pong/close and waits for authenticated completion", async () => {
  const f = fixture([
    129, 2, 104, 105, 130, 3, 0, 255, 65, 137, 1, 42, 136, 2, 3, 232,
  ]);
  const run = bridgeWebSocket(
    f.connection,
    f.peer,
    new AbortController().signal,
  );
  f.emit(new Uint8Array([0, 255, 65]));
  await run;
  assert.deepEqual(f.delivered, ["hi", new Uint8Array([0, 255, 65])]);
  assert.deepEqual(
    f.sent.map((b) => (b[0] ?? 0) & 15),
    [2, 10, 8],
  );
  assert.deepEqual([...unmask(f.sent[0]!)], [0, 255, 65]);
  assert.deepEqual([...unmask(f.sent[1]!)], [42]);
  assert.deepEqual(f.counts(), { aborted: 0, detached: 1, ended: 1 });
  assert.deepEqual(f.closes, [1000]);
});
test("failed host receipt is not reported as clean socket closure", async () => {
  const f = fixture([136, 2, 3, 232], true);
  await assert.rejects(
    bridgeWebSocket(f.connection, f.peer, new AbortController().signal),
    /receipt failed/,
  );
  assert.equal(f.counts().aborted, 1);
  assert.equal(f.counts().detached, 1);
});
test("bounded queue and explicit cancellation abort blocked streams", async () => {
  for (const flood of [false, true]) {
    const f = fixture([]),
      controller = new AbortController();
    f.connection.output = {
      [Symbol.asyncIterator]() {
        return { next: () => new Promise(() => {}) };
      },
    };
    f.connection.send = () => new Promise(() => {});
    const run = bridgeWebSocket(f.connection, f.peer, controller.signal);
    if (flood) {
      for (let i = 0; i < 257; i++) f.emit("");
    } else controller.abort(Error("revoked"));
    await assert.rejects(run, flood ? /queue limit/ : /revoked/);
    assert.equal(f.counts().aborted, 1);
    assert.equal(f.counts().detached, 1);
  }
});
