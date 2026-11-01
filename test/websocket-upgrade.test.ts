import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { HostConnection } from "../src/core/host-stream.js";
import {
  upgradeWebSocket,
  websocketAccept,
} from "../src/transport/websocket-upgrade.js";

function fixture(
  change: (headers: string) => string = (h) => h,
  width = 65536,
) {
  let sent = "",
    aborted = 0;
  let finish = () => {};
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const connection: HostConnection = {
    async send(bytes) {
      sent += new TextDecoder().decode(bytes);
    },
    async end() {
      finish();
    },
    abort() {
      aborted++;
      finish();
    },
    completed,
    output: (async function* () {
      const key = /sec-websocket-key: ([^\r]+)/i.exec(sent)?.[1];
      assert.ok(key);
      const accept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      const headers = change(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: chat\r\n`,
      );
      const raw = Buffer.concat([
        Buffer.from(headers + "\r\n"),
        Buffer.from([0x82, 3, 0, 255, 65]),
      ]);
      for (let i = 0; i < raw.length; i += width)
        yield raw.subarray(i, i + width);
    })(),
  };
  return { connection, sent: () => sent, aborted: () => aborted, finish };
}
function request(signal?: AbortSignal) {
  return new Request("https://preview.example/socket?q=1", {
    headers: {
      Upgrade: "websocket",
      "sec-websocket-protocol": "chat, other",
      "sec-websocket-extensions": "permessage-deflate",
      authorization: "secret",
      cookie: "session=secret",
    },
    ...(signal ? { signal } : {}),
  });
}
test("WebSocket handshake independently validates accept and preserves coalesced binary bytes", async () => {
  assert.equal(
    await websocketAccept("dGhlIHNhbXBsZSBub25jZQ=="),
    "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
  );
  for (const width of [1, 7, 65536]) {
    const f = fixture(undefined, width),
      controller = new AbortController();
    const result = await upgradeWebSocket(
      f.connection,
      request(controller.signal),
    );
    assert.equal(result.protocol, "chat");
    const parts = [];
    for await (const part of result.connection.output) parts.push(part);
    assert.deepEqual(Buffer.concat(parts), Buffer.from([0x82, 3, 0, 255, 65]));
    assert.ok(!f.sent().includes("secret"));
    assert.ok(!f.sent().includes("permessage-deflate"));
    assert.match(f.sent(), /^GET \/socket\?q=1 HTTP\/1.1\r\n/);
    controller.abort();
    assert.equal(f.aborted(), 1);
  }
});
test("invalid accept, duplicate headers, forbidden framing and unrequested negotiation fail closed", async () => {
  for (const change of [
    (h: string) =>
      h.replace(/Sec-WebSocket-Accept: [^\r]+/, "Sec-WebSocket-Accept: wrong"),
    (h: string) => h + "Upgrade: websocket\r\n",
    (h: string) => h + "Content-Length: 0\r\n",
    (h: string) => h + "Transfer-Encoding: chunked\r\n",
    (h: string) => h.replace("Protocol: chat", "Protocol: unknown"),
    (h: string) => h + "Sec-WebSocket-Extensions: permessage-deflate\r\n",
    (h: string) => h.replace("Connection: Upgrade", "Connection: close"),
    (h: string) =>
      h.replace("HTTP/1.1 101 Switching Protocols", "HTTP/1.1 200 OK"),
  ]) {
    const f = fixture(change);
    await assert.rejects(upgradeWebSocket(f.connection, request()));
    assert.equal(f.aborted(), 1);
  }
});
test("abort interrupts stalled upgrade without retry or half-close", async () => {
  const controller = new AbortController();
  let writes = 0,
    aborts = 0;
  const connection: HostConnection = {
    async send() {
      writes++;
    },
    async end() {
      assert.fail("unexpected half-close");
    },
    abort() {
      aborts++;
    },
    completed: new Promise(() => {}),
    output: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            controller.abort(Error("cancelled"));
            return new Promise(() => {});
          },
        };
      },
    },
  };
  await assert.rejects(
    upgradeWebSocket(connection, request(controller.signal)),
    /cancelled/,
  );
  assert.equal(writes, 1);
  assert.equal(aborts, 1);
});
