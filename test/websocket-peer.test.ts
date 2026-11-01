import assert from "node:assert/strict";
import { test } from "node:test";
import {
  platformWebSocketPeer,
  WEBSOCKET_OUTPUT_MESSAGES,
} from "../src/transport/websocket-peer.js";

class Socket extends EventTarget {
  binaryType = "blob";
  bufferedAmount?: number;
  sent: Array<string | ArrayBuffer> = [];
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }
  close() {}
}
test("platform adapter selects binary mode, preserves bytes, rejects unknown payloads and detaches", () => {
  const socket = new Socket(),
    peer = platformWebSocketPeer(socket);
  assert.equal(socket.binaryType, "arraybuffer");
  const messages: Array<string | Uint8Array> = [];
  let errors = 0;
  const handlers = {
    message: (data: string | Uint8Array) => {
      messages.push(data);
    },
    close: () => {},
    error: () => {
      errors++;
    },
  };
  const detach = peer.listen(handlers);
  socket.dispatchEvent(
    new MessageEvent("message", { data: new Uint8Array([0, 255, 65]).buffer }),
  );
  socket.dispatchEvent(new MessageEvent("message", { data: "\uFEFFtext" }));
  socket.dispatchEvent(
    new MessageEvent("message", { data: new Blob(["bad"]) }),
  );
  assert.deepEqual(messages, [new Uint8Array([0, 255, 65]), "\uFEFFtext"]);
  assert.equal(errors, 1);
  peer.send(new Uint8Array([0, 255, 65]));
  assert.deepEqual(
    new Uint8Array(socket.sent[0] as ArrayBuffer),
    new Uint8Array([0, 255, 65]),
  );
  detach();
  socket.dispatchEvent(new MessageEvent("message", { data: "ignored" }));
  assert.equal(messages.length, 2);
  assert.throws(() => peer.listen(handlers), /already attached/);
});
test("platform output bounds work without bufferedAmount and reject before sending", () => {
  const socket = new Socket(),
    peer = platformWebSocketPeer(socket);
  let sends = 0;
  socket.send = () => {
    sends++;
  };
  const payload = new Uint8Array(8 * 1024 * 1024);
  for (let i = 0; i < 8; i++) peer.send(payload);
  assert.throws(() => peer.send("x"), /cumulative/);
  assert.equal(sends, 8);
  const empty = new Socket(),
    emptyPeer = platformWebSocketPeer(empty);
  let empties = 0;
  empty.send = () => {
    empties++;
  };
  for (let i = 0; i < WEBSOCKET_OUTPUT_MESSAGES; i++) emptyPeer.send("");
  assert.throws(() => emptyPeer.send(""), /cumulative/);
  assert.equal(empties, WEBSOCKET_OUTPUT_MESSAGES);
  const buffered = new Socket();
  buffered.bufferedAmount = 8 * 1024 * 1024;
  assert.throws(() => platformWebSocketPeer(buffered).send("x"), /buffer/);
  assert.equal(buffered.sent.length, 0);
});
