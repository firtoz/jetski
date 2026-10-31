/** Real browser -> pinned fixture TLS -> host-control -> rootless workload. */
import assert from "node:assert/strict";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { createServer } from "node:tls";
import type { Scope } from "../src/core/contracts.js";
import type { PortRegistry } from "../src/core/ports.js";
import type { PreviewSessions } from "../src/core/preview-sessions.js";
import type { StreamCoordinator } from "../src/core/streams.js";
import { bearerAuthentication } from "../src/server/http.js";
import { createPreviewServer } from "../src/server/preview.js";
import { fixtureBrowser } from "./fixture-browser.js";

export async function qualifyBrowserContainer(
  scope: Scope,
  ports: PortRegistry,
  streams: StreamCoordinator,
  sessions: PreviewSessions,
) {
  if (process.env.GITHUB_ACTIONS !== "true")
    throw Error("disposable_ci_required");
  assert.ok(
    process.env.JETSKI_TEST_TLS_CERT && process.env.JETSKI_TEST_TLS_KEY,
  );
  const cert = await readFile(process.env.JETSKI_TEST_TLS_CERT),
    key = await readFile(process.env.JETSKI_TEST_TLS_KEY);
  const spki = createHash("sha256")
    .update(
      new X509Certificate(cert).publicKey.export({
        type: "spki",
        format: "der",
      }),
    )
    .digest("base64");
  const origin = "https://preview.example:9002",
    ids: string[] = [];
  const preview = createPreviewServer(
    {
      get: async (asked) =>
        asked.owner === scope.owner && asked.sandbox === scope.sandbox
          ? {
              id: scope.sandbox,
              owner: scope.owner,
              image: "fixture",
              createOperation: "create",
              placementOperation: "place",
              restoreCheckpoint: null,
              pendingResume: null,
              phase: "running",
              lease: null,
              checkpoint: null,
              generation: 1,
            }
          : undefined,
      ports,
      streams: {
        open: async (...args) => {
          const connection = await streams.open(...args);
          ids.push(args[2]);
          return connection;
        },
      },
    },
    bearerAuthentication([
      { owner: scope.owner, token: "unused-browser-control-token".repeat(2) },
    ]),
    {
      sessions,
      controlOrigins: ["https://control.example"],
      routes: [{ ...scope, exposure: "fixture-port", origin }],
    },
  );
  const sockets = new Set<Socket>();
  let targetPort = 0;
  const tls = createServer({ cert, key }, (socket) => {
    const upstream = connect({ host: "127.0.0.1", port: targetPort });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.pipe(socket).pipe(upstream);
  });
  tls.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  let browser: Awaited<ReturnType<typeof fixtureBrowser>> | undefined;
  try {
    await new Promise<void>((resolve) =>
      preview.server.listen(0, "127.0.0.1", resolve),
    );
    const address = preview.server.address();
    assert.ok(address && typeof address !== "string");
    targetPort = address.port;
    await new Promise<void>((resolve) =>
      tls.listen(9002, "127.0.0.1", resolve),
    );
    browser = await fixtureBrowser({ spki, hostname: "preview.example" });
    const grant = await sessions.mint(scope, randomUUID(), {
      exposureId: "fixture-port",
      origin,
    });
    await browser.call("Page.navigate", {
      url: `${origin}/.jetski/bootstrap#${grant.token}`,
    });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        ready =
          (await browser.evaluate(
            "location.protocol==='https:' && location.pathname==='/' && window.fixtureAsset===true",
          )) === true;
      } catch {
        /* navigation replaces context */
      }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, "HTTPS bootstrap and container asset must load");
    assert.equal(await browser.evaluate("location.hash"), "");
    assert.equal(await browser.evaluate("document.cookie"), "");
    assert.equal(
      await browser.evaluate(
        "document.body.textContent.includes('relay-container')",
      ),
      true,
    );
    assert.deepEqual(
      await browser.evaluate(
        "fetch('/binary').then(r=>{if(!r.ok)throw Error();return r.arrayBuffer()}).then(b=>[...new Uint8Array(b)])",
      ),
      [0, 255, 128, 1, 2, 3],
    );
    assert.deepEqual(
      await browser.evaluate(`new Promise((resolve,reject)=>{
      const ws=new WebSocket(location.origin.replace('https:','wss:')+'/echo'); ws.binaryType='arraybuffer';
      let bytes;
      ws.onopen=()=>ws.send(new Uint8Array([0,255,128,1,2,3]));
      ws.onmessage=e=>{bytes=[...new Uint8Array(e.data)];ws.close();};
      ws.onclose=()=>bytes?resolve(bytes):reject(Error('missing bytes'));ws.onerror=()=>reject(Error('WS failed'));
    })`),
      [0, 255, 128, 1, 2, 3],
    );
    // Do not infer host completion from the browser's close handshake.
    assert.ok(ids.length >= 4);
    for (const id of ids) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const record = await streams.inspect(scope, id);
        if (record.phase === "closed") break;
        assert.equal(record.phase, "open");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal((await streams.inspect(scope, id)).phase, "closed");
    }
    const count = ids.length;
    await sessions.revoke(scope, grant.id, randomUUID());
    assert.equal(
      await browser.evaluate("fetch('/binary').then(r=>r.status)"),
      401,
    );
    assert.equal(
      ids.length,
      count,
      "revoked browser request must not open a host stream",
    );
    console.log(
      "HTTPS browser/container: page, asset, exact binary HTTP/WSS, closed receipts and revoked admission passed",
    );
  } finally {
    await browser?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => tls.close(() => resolve()));
    await preview.close();
  }
}
