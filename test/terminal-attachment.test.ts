import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TerminalDeliveryError } from "../src/client/terminal.js";
import { type Json } from "../src/core/contracts.js";
import {
  type TerminalInput,
  terminalFrame,
} from "../src/core/terminal-input.js";
import { JetskiClient } from "../src/sdk.js";
import { SqliteState } from "../src/state/sqlite.js";

for (const admitted of [false, true])
  test(
    "attachment restart preserves identity; admitted=" + admitted,
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "jetski-attach-"));
      let state = new SqliteState(join(directory, "state.sqlite"));
      t.after(async () => {
        state.close();
        await rm(directory, { recursive: true, force: true });
      });
      const receipts = new Map<string, Json>(),
        posts: string[] = [];
      let lost = true;
      const client = new JetskiClient(
        "http://127.0.0.1",
        "private-token",
        async (url, options) => {
          if (options?.method === "GET") {
            const id = String(url).split("/").at(-1)!;
            return receipts.has(id)
              ? Response.json(receipts.get(id))
              : Response.json({}, { status: 404 });
          }
          const { id, input } = JSON.parse(String(options?.body)) as {
            id: string;
            input: TerminalInput;
          };
          posts.push(id);
          const bytes = terminalFrame(input);
          const receipt = {
            id,
            kind: input.kind,
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            sequence: 0,
            phase: "sent",
          };
          if (!lost || admitted) receipts.set(id, receipt);
          if (lost) {
            lost = false;
            throw Error("lost connection");
          }
          return Response.json(receipt);
        },
      );
      const id = randomUUID(),
        sandbox = randomUUID(),
        terminal = randomUUID();
      let attachment = await client.attachTerminal(
        state,
        id,
        sandbox,
        terminal,
      );
      await assert.rejects(
        attachment.send({ kind: "stdin", base64: "AP8=" }),
        /lost connection/,
      );
      await assert.rejects(
        attachment.send({ kind: "signal", signal: "INT" }),
        /Unresolved/,
      );
      state.close();
      state = new SqliteState(join(directory, "state.sqlite"));
      attachment = await client.attachTerminal(state, id, sandbox, terminal);
      const receipt = await attachment.resume();
      assert.equal((receipt as { phase: string }).phase, "sent");
      assert.equal(posts.length, admitted ? 1 : 2);
      assert.equal(new Set(posts).size, 1);
      await attachment.acknowledgeOutput(0, 10);
      await assert.rejects(attachment.acknowledgeOutput(0, 20), /conflict/);
      assert.equal(await attachment.cursor(), 10);
      await assert.rejects(
        new JetskiClient("http://127.0.0.1", "other-token").attachTerminal(
          state,
          id,
          sandbox,
          terminal,
        ),
        /identity/,
      );
      await assert.rejects(
        client.attachTerminal(state, id, sandbox, randomUUID()),
        /identity/,
      );
      assert.equal(
        JSON.stringify(
          await state.transaction((tx) => tx.scan("client-terminal/")),
        ).includes("private-token"),
        false,
      );
    },
  );

test("uncertain attachment input blocks continuation and survives local reopen", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-uncertain-attach-"));
  let state = new SqliteState(join(directory, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  let calls = 0;
  const client = new JetskiClient(
    "http://127.0.0.1",
    "token",
    async (_url, options) => {
      calls++;
      if (options?.method === "GET") return Response.json({}, { status: 404 });
      const { id, input } = JSON.parse(String(options?.body));
      const bytes = terminalFrame(input);
      return Response.json({
        id,
        kind: input.kind,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sequence: 0,
        phase: "uncertain",
      });
    },
  );
  const id = randomUUID(),
    sandbox = randomUUID(),
    terminal = randomUUID();
  let attachment = await client.attachTerminal(state, id, sandbox, terminal);
  await assert.rejects(
    attachment.send({ kind: "resize", rows: 40, columns: 100 }),
    TerminalDeliveryError,
  );
  assert.equal(calls, 2);
  state.close();
  state = new SqliteState(join(directory, "state.sqlite"));
  attachment = await client.attachTerminal(state, id, sandbox, terminal);
  await assert.rejects(attachment.resume(), TerminalDeliveryError);
  await assert.rejects(attachment.send({ kind: "close" }), /Unresolved/);
  assert.equal(calls, 2);
});

test("authorization and transport failures never become absence proofs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-auth-attach-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  for (const status of [401, 500]) {
    let posts = 0;
    const client = new JetskiClient(
      "http://127.0.0.1",
      "token",
      async (_url, options) => {
        if (options?.method === "POST") posts++;
        return Response.json({}, { status });
      },
    );
    const attachment = await client.attachTerminal(
      state,
      randomUUID(),
      randomUUID(),
      randomUUID(),
    );
    await assert.rejects(attachment.send({ kind: "signal", signal: "INT" }));
    await assert.rejects(attachment.resume());
    await assert.rejects(attachment.send({ kind: "close" }), /Unresolved/);
    assert.equal(posts, 0);
  }
});
