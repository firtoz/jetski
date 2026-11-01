import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { OperationJournal } from "../src/core/operations.js";
import { JetskiClient } from "../src/sdk.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "jetski-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function* stream(bytes: Uint8Array) {
  yield bytes;
}
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

test("lost command acknowledgement survives restart and cannot redispatch", async (t) => {
  const dir = await fixture(t);
  let state = new SqliteState(join(dir, "state.sqlite"));
  let journal = new OperationJournal(state);
  const fence = await journal.generation({ owner: "alice", sandbox: "box" });
  await journal.admit(fence, "cmd", "execute", {
    argv: ["sh", "-c", "echo hi"],
  });
  assert.equal(await journal.claim(fence, "cmd"), true);
  state.close();
  state = new SqliteState(join(dir, "state.sqlite"));
  t.after(() => state.close());
  journal = new OperationJournal(state);
  assert.equal(await journal.claim(fence, "cmd"), false);
  assert.equal((await journal.pending(fence))[0]?.phase, "running");
  await journal.finish(fence, "cmd", {
    phase: "uncertain",
    result: null,
    error: "transport lost",
  });
  assert.equal(await journal.claim(fence, "cmd"), false);
  await journal.finish(fence, "cmd", {
    phase: "succeeded",
    result: { exitCode: 0 },
    error: null,
  });
  assert.equal(
    (
      await journal.admit(fence, "cmd", "execute", {
        argv: ["sh", "-c", "echo hi"],
      })
    ).phase,
    "succeeded",
  );
  await assert.rejects(
    journal.admit(fence, "cmd", "execute", { argv: ["rm"] }),
    /conflict/,
  );
  assert.equal(
    await journal.get({ owner: "bob", sandbox: "box" }, "cmd"),
    undefined,
  );
  await journal.advance(fence);
  await assert.rejects(journal.claim(fence, "cmd"), /Stale/);
  await assert.rejects(
    journal.finish(fence, "cmd", {
      phase: "succeeded",
      result: null,
      error: null,
    }),
    /Stale/,
  );
});

test("transaction rollback is durable and scan prefix is literal", async (t) => {
  const dir = await fixture(t);
  const state = new SqliteState(join(dir, "state.sqlite"));
  t.after(() => state.close());
  await assert.rejects(
    state.transaction((tx) => {
      tx.put("x", 1);
      throw Error("interrupted");
    }),
  );
  assert.equal(await state.transaction((tx) => tx.get("x")), undefined);
  await state.transaction((tx) => {
    tx.put("a_%/1", 1);
    tx.put("abc/2", 2);
  });
  assert.deepEqual(await state.transaction((tx) => tx.scan("a_%/")), [
    { key: "a_%/1", value: 1 },
  ]);
  const first = new OperationJournal(state),
    second = new OperationJournal(state);
  const fence = await first.generation({ owner: "a", sandbox: "b" });
  await first.admit(fence, "once", "execute", null);
  assert.deepEqual(
    await Promise.all([
      first.claim(fence, "once"),
      second.claim(fence, "once"),
    ]),
    [true, false],
  );
});

test("immutable local objects verify bytes, ranges, owner scope and deletion tombstones", async (t) => {
  const dir = await fixture(t);
  const store = new LocalCheckpointStore(dir);
  const bytes = Uint8Array.from({ length: 200_000 }, (_, i) => i % 251);
  const address = { owner: "alice", sandbox: "box", id: "frame" };
  const info = { bytes: bytes.length, sha256: digest(bytes) };
  assert.deepEqual(await store.put(address, stream(bytes), info), {
    ...address,
    ...info,
  });
  assert.deepEqual(await store.head(address), { ...address, ...info });
  const range: Uint8Array[] = [];
  for await (const part of store.read(address, {
    start: 65530,
    endExclusive: 65600,
  }))
    range.push(part);
  assert.deepEqual(
    Buffer.concat(range),
    Buffer.from(bytes.slice(65530, 65600)),
  );
  assert.equal(
    await store.head({ owner: "bob", sandbox: "box", id: "frame" }),
    undefined,
  );
  await assert.rejects(store.put(address, stream(bytes), info), /EEXIST/);
  await store.delete(address);
  assert.equal(await store.head(address), undefined);
  await assert.rejects(store.put(address, stream(bytes), info), /EEXIST/);
  await assert.rejects(
    store.head({ owner: "../escape", sandbox: "box", id: "frame" }),
    /Invalid identifier/,
  );
});

test("interrupted and corrupt uploads never publish; corruption is observable", async (t) => {
  const dir = await fixture(t);
  const store = new LocalCheckpointStore(dir);
  const bytes = new TextEncoder().encode("hello");
  const info = { bytes: bytes.length, sha256: digest(bytes) };
  const address = { owner: "owner", sandbox: "box", id: "broken" };
  await assert.rejects(
    store.put(address, stream(bytes.slice(1)), info),
    /integrity/,
  );
  assert.equal(await store.head(address), undefined);
  const address2 = { ...address, id: "good" };
  await store.put(address2, stream(bytes), info);
  await writeFile(join(dir, "owner", "box", "good.blob"), "xxxxx");
  assert.notEqual((await store.head(address2))?.sha256, info.sha256);
  const empty = new Uint8Array();
  await store.put({ ...address, id: "empty" }, stream(empty), {
    bytes: 0,
    sha256: digest(empty),
  });
  const listed = [];
  for await (const item of store.list({ owner: "owner", sandbox: "box" }))
    listed.push(item.id);
  assert.deepEqual(listed, ["empty", "good"]);
});

test("SDK refuses insecure remote endpoints and never follows bearer redirects", async () => {
  assert.throws(
    () => new JetskiClient("http://example.com", "secret"),
    /HTTPS/,
  );
  const client = new JetskiClient(
    "https://example.com",
    "secret",
    async (url, options) => {
      assert.equal(new URL(String(url)).origin, "https://example.com");
      assert.equal(options?.redirect, "manual");
      return new Response("{}", { status: 200 });
    },
  );
  await client.operation("sandbox", "operation");
  await assert.rejects(client.request("//other.example/v1/"), /Invalid/);
});

test("SDK does not bind a receiver-sensitive fetch to the client", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async function (this: unknown, url, init) {
    assert.equal(
      this,
      undefined,
      "native fetch must not receive the client as this",
    );
    assert.equal(String(url), "https://example.com/v1/capabilities");
    assert.equal(init?.redirect, "manual");
    calls++;
    return Response.json({ version: 1 });
  };
  await new JetskiClient(
    "https://example.com",
    "fixture",
    fetcher,
  ).capabilities();
  assert.equal(calls, 1);
});

test("SDK rejects manual redirects and releases their body", async () => {
  let calls = 0,
    cancelled = false;
  const fetcher: typeof fetch = async (_url, init) => {
    assert.equal(init?.redirect, "manual");
    calls++;
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      {
        status: 302,
        headers: { location: "https://other.invalid/credential-trap" },
      },
    );
  };
  await assert.rejects(
    new JetskiClient("https://example.com", "fixture", fetcher).capabilities(),
    /302/,
  );
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});
