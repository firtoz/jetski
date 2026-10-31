import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OperationJournal } from "../src/core/operations.js";
import { PortRegistry } from "../src/core/ports.js";
import { PreviewSessions } from "../src/core/preview-sessions.js";
import { bearerAuthentication } from "../src/server/http.js";
import {
  createPreviewServer,
  type PreviewBackend,
} from "../src/server/preview.js";
import { SqliteState } from "../src/state/sqlite.js";

async function previewFetch(
  url: string,
  options: { method?: string; headers: Record<string, string>; body?: Buffer },
) {
  return new Promise<Response>((resolve, reject) => {
    const req = httpRequest(
      url,
      { method: options.method ?? "GET", headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (Array.isArray(value))
              for (const entry of value) headers.append(name, entry);
            else if (value !== undefined) headers.set(name, value);
          }
          resolve(
            new Response(
              res.statusCode === 204 ? null : Buffer.concat(chunks),
              {
                status: res.statusCode ?? 500,
                headers,
              },
            ),
          );
        });
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

test("HTTP and WebSocket previews isolate origins, strip credentials and preserve binary bytes", {
  timeout: 15000,
}, async (t) => {
  const requests: {
    path: string | undefined;
    headers: Record<string, unknown>;
    bytes: Buffer;
  }[] = [];
  const workload = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(Buffer.from(part));
    const bytes = Buffer.concat(chunks);
    requests.push({ path: req.url, headers: req.headers, bytes });
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "set-cookie": "evil=1; Domain=localhost",
      "content-length": bytes.length,
      "content-security-policy": "default-src *",
    });
    res.end(bytes);
  });
  workload.on("upgrade", (req, socket, head) => {
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    assert.equal(head.length, 0);
    const accept = createHash("sha1")
      .update(
        String(req.headers["sec-websocket-key"]) +
          "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\nSet-Cookie: evil=1\r\n\r\n`,
    );
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 2) return;
      const size = buffer[1]! & 127;
      if (buffer.length < size + 6) return;
      assert.equal(buffer[0], 0x82);
      assert.ok(buffer[1]! & 128);
      const data = Buffer.from(buffer.subarray(6, 6 + size));
      for (let i = 0; i < size; i++) data[i] = data[i]! ^ buffer[2 + (i % 4)]!;
      socket.end(Buffer.concat([Buffer.from([0x82, size]), data]));
    });
    socket.on("error", () => {});
    socket.on("end", () => socket.end());
  });
  await new Promise<void>((resolve) =>
    workload.listen(0, "127.0.0.1", resolve),
  );
  const address = workload.address();
  assert.ok(address && typeof address !== "string");
  const connections: ReturnType<typeof connect>[] = [];
  const receipts: Promise<void>[] = [];
  let opens = 0;
  const backend: PreviewBackend = {
    get: async (scope) =>
      scope.owner === "alice" && scope.sandbox === "box"
        ? {
            id: "box",
            owner: "alice",
            phase: "running",
            image: "fixture",
            generation: 1,
            lease: null,
            checkpoint: null,
            createOperation: "create",
            placementOperation: "place",
            restoreCheckpoint: null,
            pendingResume: null,
          }
        : undefined,
    ports: {
      status: async () => ({
        id: "http",
        port: address.port,
        generation: 1,
        revoked: false,
        available: true,
      }),
    },
    streams: {
      open: async (scope, exposure, _id, signal) => {
        assert.equal(scope.owner, "alice");
        assert.equal(exposure, "http");
        opens++;
        const socket = connect({
          port: address.port,
          host: "127.0.0.1",
          allowHalfOpen: true,
        });
        connections.push(socket);
        await once(socket, "connect");
        let inputEnded = false,
          failure = false;
        let resolve!: () => void, reject!: (error: Error) => void;
        const completed = new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        receipts.push(completed);
        void completed.catch(() => {});
        socket.on("error", () => {
          failure = true;
          reject(Error("private backend error"));
        });
        socket.once("close", () => {
          setTimeout(() => {
            if (inputEnded && socket.readableEnded && !failure) resolve();
            else reject(Error("Incomplete stream"));
          }, 20);
        });
        const abort = () => {
          failure = true;
          socket.destroy();
          reject(Error("Aborted stream"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        void completed
          .finally(() => signal?.removeEventListener("abort", abort))
          .catch(() => {});
        return {
          completed,
          abort,
          output: {
            [Symbol.asyncIterator]: () =>
              socket.iterator({ destroyOnReturn: false }),
          },
          send: async (bytes) => {
            assert.ok(bytes.length <= 16384);
            await new Promise<void>((resolve, reject) =>
              socket.write(bytes, (error) =>
                error ? reject(error) : resolve(),
              ),
            );
          },
          end: async () => {
            inputEnded = true;
            await new Promise<void>((resolve) => socket.end(resolve));
          },
        };
      },
    },
  };
  const auth = bearerAuthentication([
    { owner: "alice", token: "a".repeat(32) },
    { owner: "bob", token: "b".repeat(32) },
  ]);
  const route = {
    origin: "http://127.0.0.1:9001",
    owner: "alice",
    sandbox: "box",
    exposure: "http",
  };
  assert.throws(
    () =>
      createPreviewServer(backend, auth, {
        routes: [route],
        controlOrigins: [route.origin],
      }),
    /isolated/,
  );
  const directory = await mkdtemp(join(tmpdir(), "jetski-preview-auth-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  const operations = new OperationJournal(state);
  const scope = { owner: "alice", sandbox: "box" };
  await operations.generation(scope);
  const sessionPorts = new PortRegistry(state, operations, () => ({
    generation: 1,
    running: true,
    image: "fixture",
    lease: {
      owner: "alice",
      sandboxId: "box",
      machineId: "host",
      poolId: "pool",
      slotId: "slot",
      assignmentId: "assignment",
      generation: 1,
    },
  }));
  await sessionPorts.expose(scope, "http", address.port);
  const sessions = new PreviewSessions(state, operations, sessionPorts);
  const preview = createPreviewServer(backend, auth, {
    sessions,
    routes: [route],
    controlOrigins: ["http://localhost:8788"],
  });
  await new Promise<void>((resolve) =>
    preview.server.listen(0, "127.0.0.1", resolve),
  );
  const listener = preview.server.address();
  assert.ok(listener && typeof listener !== "string");
  t.after(async () => {
    await preview.close();
    state.close();
    await rm(directory, { recursive: true, force: true });
    for (const connection of connections) connection.destroy();
    workload.closeAllConnections();
    await new Promise<void>((resolve) => workload.close(() => resolve()));
  });
  const url = `http://127.0.0.1:${listener.port}/binary?test=1`;
  const headers = {
    host: "127.0.0.1:9001",
    authorization: "Bearer " + "a".repeat(32),
    cookie: "private=secret",
    origin: route.origin,
  };
  assert.equal(
    (await previewFetch(url, { headers: { host: headers.host } })).status,
    401,
  );
  assert.equal(
    (
      await previewFetch(url, {
        headers: { ...headers, authorization: "Bearer " + "b".repeat(32) },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await previewFetch(url, {
        headers: { ...headers, origin: "https://foreign.example" },
      })
    ).status,
    403,
  );
  async function rejectedUpgrade(extra: Record<string, string>) {
    return new Promise<number>((resolve, reject) => {
      const req = httpRequest(url, {
        headers: {
          ...headers,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": Buffer.alloc(16, 7).toString("base64"),
          ...extra,
        },
      });
      req.on("error", reject);
      req.on("upgrade", (_res, socket) => {
        socket.destroy();
        reject(Error("Unauthorized upgrade"));
      });
      req.on("response", (response) => {
        response.resume();
        resolve(response.statusCode!);
      });
      req.end();
    });
  }
  assert.equal(await rejectedUpgrade({ authorization: "" }), 401);
  assert.equal(
    await rejectedUpgrade({ origin: "https://foreign.example" }),
    403,
  );
  assert.equal(
    await rejectedUpgrade({ "sec-websocket-key": "not-a-key" }),
    400,
  );
  assert.equal(opens, 0);
  const bytes = Buffer.from(
    Array.from({ length: 1024 * 1024 }, (_, i) => i % 251),
  );
  const response = await previewFetch(url, {
    method: "POST",
    headers,
    body: bytes,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.match(
    response.headers.get("content-security-policy")!,
    /worker-src 'none'/,
  );
  assert.ok(response.headers.get("x-jetski-stream-id"));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  const grant = await sessions.mint(scope, "browser-grant", {
    exposureId: "http",
    origin: route.origin,
  });
  const bootstrapUrl = new URL("/.jetski/bootstrap", url).href;
  const bootstrap = await previewFetch(bootstrapUrl, {
    headers: { host: headers.host },
  });
  assert.equal(bootstrap.status, 200);
  assert.match(
    bootstrap.headers.get("content-security-policy")!,
    /script-src 'sha256-/,
  );
  assert.equal((await bootstrap.text()).includes(grant.token), false);
  const redeemUrl = new URL("/.jetski/redeem", url).href;
  const redeemHeaders = {
    host: headers.host,
    origin: route.origin,
    "content-type": "application/json",
  };
  const redeemBody = Buffer.from(
    JSON.stringify({ token: grant.token, redemption: "browser-redemption" }),
  );
  assert.equal(
    (
      await previewFetch(redeemUrl, {
        method: "POST",
        headers: { ...redeemHeaders, origin: "https://foreign.example" },
        body: redeemBody,
      })
    ).status,
    403,
  );
  const redeemed = await previewFetch(redeemUrl, {
    method: "POST",
    headers: redeemHeaders,
    body: redeemBody,
  });
  assert.equal(redeemed.status, 204);
  const setCookie = redeemed.headers.get("set-cookie")!;
  assert.match(
    setCookie,
    /; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=/,
  );
  assert.equal(setCookie.includes("Domain="), false);
  const cookie = setCookie.split(";")[0]!;
  const retry = await previewFetch(redeemUrl, {
    method: "POST",
    headers: redeemHeaders,
    body: redeemBody,
  });
  assert.equal(retry.headers.get("set-cookie")!.split(";")[0], cookie);
  assert.equal(
    (
      await previewFetch(redeemUrl, {
        method: "POST",
        headers: redeemHeaders,
        body: Buffer.from(
          JSON.stringify({ token: grant.token, redemption: "other" }),
        ),
      })
    ).status,
    403,
  );
  const sessionHeaders = { host: headers.host, origin: route.origin, cookie };
  const authenticated = await previewFetch(url, {
    method: "POST",
    headers: sessionHeaders,
    body: bytes,
  });
  assert.equal(authenticated.status, 200);
  assert.deepEqual(Buffer.from(await authenticated.arrayBuffer()), bytes);
  assert.equal(requests[1]!.headers.cookie, undefined);
  const websocket = httpRequest(url, {
    headers: {
      ...sessionHeaders,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": Buffer.alloc(16, 7).toString("base64"),
    },
  });
  const upgrade = once(websocket, "upgrade");
  websocket.end();
  const [upgradeResponse, socket, initial] = await upgrade;
  assert.equal(upgradeResponse.statusCode, 101);
  assert.equal(upgradeResponse.headers["set-cookie"], undefined);
  const payload = Buffer.from([0, 255, 128, 1, 2, 3]);
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] = masked[i]! ^ mask[i % 4]!;
  const output: Buffer[] = [initial];
  socket.on("data", (part: Buffer) => output.push(Buffer.from(part)));
  const closed = once(socket, "close");
  socket.end(
    Buffer.concat([Buffer.from([0x82, 128 | payload.length]), mask, masked]),
  );
  await closed;
  assert.deepEqual(
    Buffer.concat(output),
    Buffer.concat([Buffer.from([0x82, payload.length]), payload]),
  );
  await Promise.all(receipts);
  assert.equal(requests[0]!.path, "/binary?test=1");
  assert.equal(requests[0]!.headers.authorization, undefined);
  assert.equal(requests[0]!.headers.cookie, undefined);
  assert.equal(requests[0]!.headers.origin, undefined);
  assert.deepEqual(requests[0]!.bytes, bytes);
  const idle = httpRequest(url, {
    headers: {
      ...sessionHeaders,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": Buffer.alloc(16, 7).toString("base64"),
    },
  });
  const idleUpgrade = once(idle, "upgrade");
  idle.end();
  const [, idleSocket] = await idleUpgrade;
  idleSocket.on("error", () => {});
  const idleClosed = once(idleSocket, "close", {
    signal: AbortSignal.timeout(5000),
  });
  idleSocket.resume();
  const deniedReceipt = assert.rejects(receipts.at(-1)!);
  await sessions.revoke(scope, "browser-grant", "revoke-browser-grant");
  await idleClosed;
  await deniedReceipt;
  assert.equal(
    (await previewFetch(url, { headers: sessionHeaders })).status,
    401,
  );
  const priorOpens = opens;
  let started!: () => void;
  const authenticating = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = createPreviewServer(
    backend,
    () => {
      started();
      return new Promise(() => {});
    },
    {
      routes: [route],
      controlOrigins: ["http://localhost:8788"],
    },
  );
  await new Promise<void>((resolve) =>
    pending.server.listen(0, "127.0.0.1", resolve),
  );
  const pendingAddress = pending.server.address();
  assert.ok(pendingAddress && typeof pendingAddress !== "string");
  const abandoned = httpRequest({
    host: "127.0.0.1",
    port: pendingAddress.port,
    headers,
  });
  abandoned.on("error", () => {});
  abandoned.end();
  await authenticating;
  await pending.close();
  abandoned.destroy();
  assert.equal(
    opens,
    priorOpens,
    "Shutdown cannot admit a stalled authentication",
  );
});
