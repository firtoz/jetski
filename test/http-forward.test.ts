import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import type { HostConnection } from "../src/core/host-stream.js";
import { forwardHttp, previewHeaders } from "../src/transport/http-forward.js";

test("portable HTTP forwarding streams binary uploads to a real HTTP server without credentials", async () => {
  const payload = Buffer.from(Array.from({ length: 70001 }, (_, i) => i % 256));
  let received = Buffer.alloc(0);
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/echo?q=hello%20world");
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers["x-private"], undefined);
    assert.equal(req.headers.host, "preview.example");
    const chunks = [];
    for await (const b of req) chunks.push(b);
    received = Buffer.concat(chunks);
    res.writeHead(201, {
      "Content-Type": "application/octet-stream",
      "Set-Cookie": "secret=1",
      "X-Result": "yes",
    });
    res.end(received);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("address");
  const socket = connect({
    host: "127.0.0.1",
    port: address.port,
    allowHalfOpen: true,
  });
  await once(socket, "connect");
  const completed = new Promise<void>((resolve, reject) => {
    socket.once("close", (hadError) =>
      hadError ? reject(Error("transport failed")) : resolve(),
    );
    socket.once("error", reject);
  });
  const connection: HostConnection = {
    output: socket,
    send: (bytes) =>
      new Promise((resolve, reject) =>
        socket.write(bytes, (e) => (e ? reject(e) : resolve())),
      ),
    end: () => new Promise((resolve) => socket.end(resolve)),
    abort: () => {
      socket.destroy();
    },
    completed,
  };
  try {
    const result = await forwardHttp(
      connection,
      new Request("https://preview.example/echo?q=hello%20world", {
        method: "POST",
        headers: {
          authorization: "Bearer private",
          cookie: "session=private",
          connection: "x-private",
          "x-private": "hidden",
        },
        body: payload,
      }),
    );
    assert.equal(result.status, 201);
    assert.equal(result.headers.get("set-cookie"), null);
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.equal(result.headers.get("x-result"), "yes");
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), payload);
    assert.deepEqual(received, payload);
  } finally {
    socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
function fixture(raw: string, receipt: Promise<void> = Promise.resolve()) {
  let aborted = 0;
  const sent: Uint8Array[] = [];
  const connection: HostConnection = {
    output: (async function* () {
      yield new TextEncoder().encode(raw);
    })(),
    async send(bytes) {
      sent.push(bytes.slice());
    },
    async end() {},
    abort() {
      aborted++;
    },
    completed: receipt,
  };
  return { connection, sent, aborted: () => aborted };
}
test("HTTP EOF does not hide a failed host receipt", async () => {
  const f = fixture(
    "HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\na",
    Promise.reject(Error("bad host receipt")),
  );
  const result = await forwardHttp(
    f.connection,
    new Request("https://preview.example/"),
  );
  await assert.rejects(result.arrayBuffer(), /bad host receipt/);
  assert.ok(f.aborted() > 0);
});
test("malformed and cancelled responses abort their connection", async () => {
  const malformed = fixture("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\na");
  const response = await forwardHttp(
    malformed.connection,
    new Request("https://preview.example/"),
  );
  await assert.rejects(response.arrayBuffer(), /Truncated/);
  assert.ok(malformed.aborted() > 0);
  const cancel = fixture("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc");
  const other = await forwardHttp(
    cancel.connection,
    new Request("https://preview.example/"),
  );
  await other.body?.cancel();
  assert.ok(cancel.aborted() > 0);
  const denied = fixture("");
  await assert.rejects(
    forwardHttp(
      denied.connection,
      new Request("https://preview.example/", {
        headers: { upgrade: "websocket" },
      }),
    ),
    /upgrade/,
  );
  assert.equal(denied.sent.length, 0);
  assert.ok(denied.aborted() > 0);
});
test("preview header policy strips hop credentials and replaces workload security policy", () => {
  const result = previewHeaders(
    [
      ["Connection", "x-remove"],
      ["X-Remove", "private"],
      ["Authorization", "secret"],
      ["Cookie", "secret"],
      ["Set-Cookie", "secret"],
      ["X-Forwarded-Host", "private"],
      ["Content-Security-Policy", "unsafe"],
      ["Service-Worker-Allowed", "/"],
      ["Content-Type", "text/html"],
    ],
    true,
  );
  assert.equal(result.get("x-remove"), null);
  assert.equal(result.get("authorization"), null);
  assert.equal(result.get("cookie"), null);
  assert.equal(result.get("set-cookie"), null);
  assert.equal(result.get("x-forwarded-host"), null);
  assert.equal(result.get("service-worker-allowed"), null);
  assert.match(
    result.get("content-security-policy") ?? "",
    /worker-src 'none'/,
  );
  assert.equal(result.get("content-type"), "text/html");
});

test("locked upload and pre-aborted requests release connection without sending", async () => {
  const request = new Request("https://preview.example/", {
    method: "POST",
    body: "test",
  });
  const lock = request.body?.getReader();
  const locked = fixture("");
  await assert.rejects(forwardHttp(locked.connection, request));
  assert.equal(locked.sent.length, 0);
  assert.equal(locked.aborted(), 1);
  lock?.releaseLock();
  const stopped = fixture("");
  await assert.rejects(
    forwardHttp(
      stopped.connection,
      new Request("https://preview.example/", { signal: AbortSignal.abort() }),
    ),
  );
  assert.equal(stopped.sent.length, 0);
  assert.equal(stopped.aborted(), 1);
});
