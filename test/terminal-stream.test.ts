import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { JetskiClient } from "../src/sdk.js";

test("terminal output follows demand and resumes exact binary cursors without mutations", async () => {
  const calls: number[] = [];
  const payload = Buffer.from([0, 255, 13, 10]);
  const client = new JetskiClient(
    "http://127.0.0.1",
    "test",
    async (url, options) => {
      assert.equal(options?.method, "GET");
      const offset = Number(new URL(String(url)).searchParams.get("offset"));
      calls.push(offset);
      const bytes = payload.subarray(offset, offset + 2);
      return Response.json({
        base64: bytes.toString("base64"),
        nextOffset: offset + bytes.length,
        terminal: offset + bytes.length === payload.length,
      });
    },
  );
  const sandbox = randomUUID(),
    terminal = randomUUID();
  const first = client.followTerminal(sandbox, terminal);
  const chunk = (await first.next()).value!;
  assert.deepEqual(Buffer.from(chunk.bytes), payload.subarray(0, 2));
  assert.deepEqual(calls, [0]);
  await first.return(undefined);
  assert.deepEqual(calls, [0]);
  const resumed: Uint8Array[] = [];
  for await (const part of client.followTerminal(sandbox, terminal, {
    offset: chunk.nextOffset,
  }))
    resumed.push(part.bytes);
  assert.deepEqual(Buffer.concat([chunk.bytes, ...resumed]), payload);
  assert.deepEqual(calls, [0, 2]);
});

test("terminal output rejects cursor corruption and noncanonical data", async () => {
  for (const segment of [
    { base64: "YQ==", nextOffset: 2, terminal: true },
    { base64: "YQ", nextOffset: 1, terminal: true },
    { base64: "", nextOffset: -1, terminal: false },
    { base64: "", nextOffset: 0, terminal: "yes" },
  ]) {
    const client = new JetskiClient("http://127.0.0.1", "test", async () =>
      Response.json(segment),
    );
    await assert.rejects(
      client.followTerminal(randomUUID(), randomUUID()).next(),
    );
  }
});

test("aborting an idle follower stops observation without cancelling its terminal", async () => {
  const controller = new AbortController();
  let calls = 0;
  let requested!: () => void;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const client = new JetskiClient(
    "http://127.0.0.1",
    "test",
    async (_url, options) => {
      calls++;
      assert.equal(options?.method, "GET");
      assert.equal(options?.signal, controller.signal);
      requested();
      return Response.json({ base64: "", nextOffset: 0, terminal: false });
    },
  );
  const next = client
    .followTerminal(randomUUID(), randomUUID(), { signal: controller.signal })
    .next();
  await started;
  controller.abort(new Error("detached"));
  await assert.rejects(next, /detached/);
  assert.equal(calls, 1);
});
