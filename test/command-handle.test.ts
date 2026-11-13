import assert from "node:assert/strict";
import test from "node:test";
import type { SandboxOperation } from "../src/sdk.js";
import {
  CommandOutcomeError,
  Jetski,
  JetskiClient,
  JetskiHttpError,
  JetskiOperationError,
} from "../src/sdk.js";

function fixture() {
  let phase = "running",
    cancelled = 0,
    started = 0,
    lost = true;
  const intents: SandboxOperation[] = [];
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)),
      parts = path.pathname.split("/");
    calls.push(`${init?.method} ${path.pathname}`);
    if (init?.method === "POST" && parts.at(-1) === "commands") {
      const value: unknown = JSON.parse(String(init.body));
      assert.ok(value && typeof value === "object" && "id" in value);
      assert.ok(intents.some((intent) => intent.operationId === value.id));
      started++;
      if (lost) {
        lost = false;
        throw Error("lost acknowledgement");
      }
    }
    if (parts.at(-1) === "cancel") {
      cancelled++;
      return Response.json({ phase: "running" });
    }
    if (parts.at(-1) === "output") {
      const offset = Number(path.searchParams.get("offset"));
      const bytes = Buffer.from("hello").subarray(offset, offset + 2);
      return Response.json({
        base64: bytes.toString("base64"),
        nextOffset: offset + bytes.length,
        terminal: offset + bytes.length === 5,
      });
    }
    if (parts.length === 4)
      return Response.json({
        id: "sandbox",
        createOperation: "create",
        phase: "running",
        generation: 1,
      });
    return Response.json({ phase, exitCode: phase === "succeeded" ? 0 : null });
  };
  const connect = () =>
    new Jetski({
      url: "https://example.invalid",
      token: "private",
      fetch: fetcher,
      onOperation: (intent) => {
        intents.push(intent);
      },
    });
  return {
    connect,
    calls,
    intents,
    finish: () => {
      phase = "succeeded";
    },
    uncertain: () => {
      phase = "uncertain";
    },
    get started() {
      return started;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

test("lost acknowledgement, abort and reconnect preserve command identity and output cursors", async () => {
  const f = fixture(),
    session = await f.connect().get("sandbox");
  await assert.rejects(session.startCommand(["work"]), JetskiOperationError);
  const saved = f.intents[0]!;
  const command = (await f.connect().get(saved.sandboxId)).command(
    saved.operationId,
  );
  await assert.rejects(
    command.wait({ waitTimeoutMs: 5 }),
    (error) =>
      error instanceof JetskiOperationError &&
      error.cause instanceof DOMException &&
      error.cause.name === "TimeoutError",
  );
  assert.equal(f.cancelled, 0);
  f.finish();
  let cursor = 0;
  for await (const part of command.output("stdout")) {
    cursor = part.nextOffset;
    assert.equal(Buffer.from(part.bytes).toString(), "he");
    break;
  }
  const chunks: Uint8Array[] = [];
  for await (const part of (await f.connect().get(saved.sandboxId))
    .command(saved.operationId)
    .output("stdout", { offset: cursor }))
    chunks.push(part.bytes);
  assert.equal(Buffer.concat(chunks).toString(), "llo");
  const before = f.calls.length;
  await assert.rejects(command.wait({ signal: AbortSignal.abort() }));
  assert.equal(f.calls.length, before);
  assert.equal((await command.wait()).exitCode, 0);
  assert.equal(f.started, 1);
  assert.equal(f.cancelled, 0);
});

test("uncertain outcomes stay typed and only explicit cancellation requests cancel", async () => {
  const f = fixture(),
    s = await f.connect().get("sandbox");
  await assert.rejects(s.startCommand(["work"]));
  const c = s.command(f.intents[0]!.operationId);
  f.uncertain();
  await assert.rejects(
    c.wait(),
    (error) =>
      error instanceof JetskiOperationError &&
      error.cause instanceof CommandOutcomeError,
  );
  assert.equal(f.cancelled, 0);
  await c.cancel();
  assert.equal(f.cancelled, 1);
  assert.equal(f.started, 1);
  await assert.rejects(async () => {
    for await (const _part of c.output("stdout", { offset: -1 })) {
    }
  });
});

test("HTTP contract classifications survive split response bodies without exposing messages", async () => {
  const bytes = new TextEncoder().encode('{"error":"stale-generation"}');
  const client = new JetskiClient(
    "https://example.invalid",
    "private",
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice(0, 5));
            controller.enqueue(bytes.slice(5));
            controller.close();
          },
        }),
        { status: 409 },
      ),
  );
  await assert.rejects(
    client.getSandbox("sandbox"),
    (error) =>
      error instanceof JetskiHttpError &&
      error.code === "stale-generation" &&
      error.status === 409,
  );
});

test("preview persistence is bounded and failed persistence never dispatches a grant", async () => {
  let calls = 0;
  const keepAlive = setInterval(() => {}, 100);
  const jetski = new Jetski({
    url: "https://example.invalid",
    token: "private",
    fetch: async () => {
      calls++;
      return Response.json({});
    },
    onOperation: () => new Promise<void>(() => {}),
  });
  try {
    await assert.rejects(
      jetski.preview("sandbox", "exposure", "https://preview.invalid", {
        waitTimeoutMs: 5,
      }),
      JetskiOperationError,
    );
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(calls, 0);
});
