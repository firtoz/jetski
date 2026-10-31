/** Disposable host qualification for proxy transport, not browser login UX. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import type { Scope } from "../src/core/contracts.js";
import type { PortRegistry } from "../src/core/ports.js";
import type { StreamCoordinator } from "../src/core/streams.js";
import { bearerAuthentication } from "../src/server/http.js";
import { createPreviewServer } from "../src/server/preview.js";

export async function qualifyPreview(
  scope: Scope,
  ports: PortRegistry,
  streams: StreamCoordinator,
  websocket: boolean,
) {
  if (process.env.GITHUB_ACTIONS !== "true")
    throw Error("disposable_ci_required");
  const token = "qualification-only-preview-token".repeat(2);
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
      streams,
    },
    bearerAuthentication([{ owner: scope.owner, token }]),
    {
      controlOrigins: ["https://control.example"],
      routes: [
        {
          origin: "https://preview.example",
          ...scope,
          exposure: "fixture-port",
        },
      ],
    },
  );
  try {
    await new Promise<void>((resolve) =>
      preview.server.listen(0, "127.0.0.1", resolve),
    );
    const address = preview.server.address();
    assert.ok(address && typeof address !== "string");
    const headers: Record<string, string> = {
      host: "preview.example",
      authorization: `Bearer ${token}`,
      cookie: "private-control-cookie=1",
    };
    if (websocket)
      Object.assign(headers, {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      });
    const req = request({
      host: "127.0.0.1",
      port: address.port,
      path: "/",
      headers,
    });
    let id: string;
    if (websocket) {
      const upgrade = once(req, "upgrade", {
        signal: AbortSignal.timeout(15000),
      });
      req.end();
      const [response, socket, head] = await upgrade;
      assert.equal(response.statusCode, 101);
      id = response.headers["x-jetski-stream-id"];
      const output: Buffer[] = [head];
      socket.on("data", (bytes: Buffer) => output.push(Buffer.from(bytes)));
      const closed = once(socket, "close", {
        signal: AbortSignal.timeout(15000),
      });
      const data = Buffer.from([0, 255, 128, 1, 2, 3]),
        mask = Buffer.from([1, 2, 3, 4]);
      const masked = Buffer.from(data);
      for (let i = 0; i < data.length; i++)
        masked[i] = masked[i]! ^ mask[i % 4]!;
      socket.end(Buffer.concat([Buffer.from([0x82, 0x86]), mask, masked]));
      await closed;
      assert.deepEqual(
        Buffer.concat(output),
        Buffer.concat([Buffer.from([0x82, 6]), data]),
      );
    } else {
      const responseReady = once(req, "response", {
        signal: AbortSignal.timeout(15000),
      });
      req.end();
      const [response] = await responseReady;
      assert.equal(response.statusCode, 200);
      id = response.headers["x-jetski-stream-id"];
      const output: Buffer[] = [];
      for await (const bytes of response) output.push(Buffer.from(bytes));
      assert.equal(Buffer.concat(output).toString(), "relay-container");
    }
    assert.ok(id!);
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await streams.inspect(scope, id!);
      if (status.phase === "closed") break;
      assert.equal(
        status.phase,
        "open",
        `Preview receipt uncertain (websocket=${websocket})`,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal((await streams.inspect(scope, id!)).phase, "closed");
  } finally {
    await preview.close();
  }
}
