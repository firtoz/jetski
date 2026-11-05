import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { SandboxOperation } from "../src/client/sandbox.js";
import {
  Jetski,
  JetskiCommandError,
  JetskiOperationError,
} from "../src/sdk.js";

function fixture(
  options: {
    binary?: boolean;
    badCursor?: boolean;
    uncertain?: boolean;
    lostCreate?: boolean;
    lostStop?: boolean;
    nonzero?: boolean;
  } = {},
) {
  const calls: Array<{
    path: string;
    method: string;
    body: Record<string, unknown>;
  }> = [];
  const announced: SandboxOperation[] = [];
  let sandbox = "",
    stopCalls = 0,
    generation = 1,
    phase = "running";
  const transport: typeof fetch = async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = new URL(String(input)),
      parts = url.pathname.split("/").filter(Boolean);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const method = init?.method ?? "GET";
    calls.push({ path: url.pathname, method, body });
    if (method === "POST") {
      const id = body.operationId ?? body.id;
      assert.ok(
        announced.some((a) => a.operationId === id),
        "ID recorded before dispatch",
      );
      if (parts.length === 2) {
        sandbox = body.id;
        phase = body.sourceSandbox ? "stopped" : "running";
        if (options.lostCreate) throw Error("lost create acknowledgement");
      }
      if (parts[3] === "stop") phase = "stopped";
      if (parts[3] === "resume") {
        generation++;
        phase = "running";
      }
      if (parts[3] === "stop" && options.lostStop && ++stopCalls === 1)
        throw Error("lost stop acknowledgement");
      return Response.json({ phase: "queued" });
    }
    if (parts[3] === "operations")
      return Response.json({ id: parts[4], phase: "succeeded" });
    if (parts.length === 3)
      return Response.json({
        id: sandbox,
        generation,
        phase,
        lease: null,
        checkpoint: "fixture-root",
        image: "image",
      });
    if (parts[5] === "output") {
      const bytes =
        url.searchParams.get("channel") === "stderr"
          ? new Uint8Array()
          : options.binary
            ? Uint8Array.from([0, 255, 128, 10])
            : new TextEncoder().encode("Héllo, world!\n");
      const offset = Number(url.searchParams.get("offset")),
        end = Math.min(bytes.length, offset + 2);
      return Response.json({
        base64: Buffer.from(bytes.slice(offset, end)).toString("base64"),
        nextOffset: end + (options.badCursor ? 1 : 0),
        terminal: end === bytes.length,
      });
    }
    return Response.json({
      phase: options.uncertain
        ? "uncertain"
        : options.nonzero
          ? "failed"
          : "succeeded",
      exitCode: options.nonzero ? 7 : 0,
    });
  };
  const client = new Jetski({
    url: "https://example.invalid",
    token: "t".repeat(32),
    fetch: transport,
    onOperation: (op) => {
      announced.push(op);
    },
  });
  return { client, calls, announced, transport };
}

test("facade creates, observes exact split UTF-8 output and durably stops with stable IDs", async () => {
  const f = fixture(),
    sandbox = await f.client.create({
      image: "example@sha256:" + "a".repeat(64),
    });
  const result = await sandbox.exec(["echo", "hello"]);
  assert.equal(result.stdout, "Héllo, world!\n");
  assert.deepEqual(result.stdoutBytes, new TextEncoder().encode(result.stdout));
  await sandbox.stop();
  await sandbox.stop();
  const stops = f.calls.filter((c) => c.path.endsWith("/stop"));
  assert.equal(stops.length, 2);
  assert.equal(stops[0]!.body.operationId, stops[1]!.body.operationId);
  assert.equal(
    f.calls.filter((c) => c.method === "POST" && c.path.endsWith("/commands"))
      .length,
    1,
  );
});
test("binary bytes stay exact and text access refuses lossy decoding; invalid cursors fail closed", async () => {
  const f = fixture({ binary: true }),
    sandbox = await f.client.create({ image: "image" });
  const result = await sandbox.exec(["binary"]);
  assert.deepEqual([...result.stdoutBytes], [0, 255, 128, 10]);
  assert.throws(() => result.stdout);
  const bad = fixture({ badCursor: true }),
    other = await bad.client.create({ image: "image" });
  await assert.rejects(other.exec(["binary"]), JetskiOperationError);
  assert.equal(
    bad.calls.filter((c) => c.method === "POST" && c.path.endsWith("/commands"))
      .length,
    1,
  );
});
test("lost acknowledgements expose recovery IDs and never cause automatic mutation replay", async () => {
  const f = fixture({ lostCreate: true }),
    id = randomUUID(),
    operationId = randomUUID();
  await assert.rejects(
    f.client.create({ id, image: "image", operationId }),
    (error) => {
      assert.ok(error instanceof JetskiOperationError);
      assert.equal(error.operation.sandboxId, id);
      assert.equal(error.operation.operationId, operationId);
      return true;
    },
  );
  assert.equal(f.calls.length, 1);
  const s = fixture({ lostStop: true }),
    sandbox = await s.client.create({ image: "image" });
  await assert.rejects(sandbox.stop(), JetskiOperationError);
  await sandbox.stop();
  const stops = s.calls.filter((c) => c.path.endsWith("/stop"));
  assert.equal(stops[0]!.body.operationId, stops[1]!.body.operationId);
});
test("uncertain execution is observed, never cancelled or re-executed", async () => {
  const f = fixture({ uncertain: true }),
    sandbox = await f.client.create({ image: "image" });
  await assert.rejects(sandbox.exec(["work"]), JetskiOperationError);
  assert.equal(
    f.calls.filter((c) => c.method === "POST" && c.path.endsWith("/commands"))
      .length,
    1,
  );
  assert.equal(f.calls.filter((c) => c.path.endsWith("/cancel")).length, 0);
});
test("nonzero exit includes captured bytes; callers may explicitly inspect exit status", async () => {
  const f = fixture({ nonzero: true }),
    sandbox = await f.client.create({ image: "image" });
  await assert.rejects(sandbox.exec(["fail"]), (error) => {
    assert.ok(error instanceof JetskiOperationError);
    assert.ok(error.cause instanceof JetskiCommandError);
    assert.equal(error.cause.result.exitCode, 7);
    assert.equal(error.cause.result.stdout, "Héllo, world!\n");
    return true;
  });
  assert.equal((await sandbox.exec(["fail"], { check: false })).exitCode, 7);
});
test("ID persistence failure/timeout prevents dispatch; aborted clients do not send cancellation", async () => {
  const f = fixture();
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    f.client.create({ image: "image", signal: abort.signal }),
    JetskiOperationError,
  );
  assert.equal(f.calls.length, 0);
  const client = new Jetski({
    url: "https://example.invalid",
    token: "token",
    fetch: f.transport,
    onOperation: async () => {
      await delay(50);
    },
  });
  await assert.rejects(
    client.create({ image: "image", waitTimeoutMs: 5 }),
    JetskiOperationError,
  );
  await delay(60);
  assert.equal(f.calls.length, 0);
});

test("HTTP facade copies into a distinct stopped sandbox and reports a lost copy acknowledgement without replay", async () => {
  const f = fixture();
  const original = await f.client.create({ image: "image" });
  const restored = await f.client.fromCheckpoint({
    sourceSandboxId: original.id,
    checkpointId: "root",
    image: "image",
  });
  assert.notEqual(restored.id, original.id);
  assert.equal((await restored.inspect()).phase, "stopped");
  const post = f.calls.filter((c) => c.method === "POST").at(-1)!;
  assert.equal(post.body.sourceSandbox, original.id);
  assert.equal(post.body.checkpointId, "root");
  assert.equal(f.announced.at(-1)!.kind, "copy");
  await restored.resume();
  assert.equal(
    (await restored.exec(["echo", "hello"])).stdout,
    "Héllo, world!\n",
  );
  const lost = fixture({ lostCreate: true });
  await assert.rejects(
    lost.client.fromCheckpoint({
      sourceSandboxId: original.id,
      checkpointId: "root",
      image: "image",
    }),
    (error) => {
      assert.ok(error instanceof JetskiOperationError);
      assert.equal(error.operation.kind, "copy");
      return true;
    },
  );
  assert.equal(lost.calls.length, 1);
});
