import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { HostDuplex } from "../src/transport/duplex.js";

function fixture() {
  const output = new PassThrough();
  let resolve!: () => void, reject!: (error: Error) => void;
  const completed = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const inputs: Buffer[] = [];
  let ends = 0,
    aborts = 0,
    pending = false;
  const duplex = new HostDuplex({
    output,
    completed,
    async send(bytes) {
      assert.equal(pending, false);
      pending = true;
      assert.ok(bytes.length <= 16384);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inputs.push(Buffer.from(bytes));
      pending = false;
    },
    async end() {
      assert.equal(pending, false);
      ends++;
    },
    abort() {
      aborts++;
      output.destroy();
      reject(Error("private transport diagnostic"));
    },
  });
  duplex.on("error", () => {});
  return {
    duplex,
    output,
    resolve,
    reject,
    inputs,
    ends: () => ends,
    aborts: () => aborts,
  };
}

test("Node adapter preserves both half-close orders and waits for verified host completion", async () => {
  for (const remoteFirst of [true, false]) {
    const f = fixture();
    const bytes = Buffer.from(Array.from({ length: 65536 }, (_, i) => i % 251));
    const received: Buffer[] = [];
    f.duplex.on("data", (part: Buffer) => received.push(Buffer.from(part)));
    const ended = once(f.duplex, "end"),
      finished = once(f.duplex, "finish");
    if (remoteFirst) {
      f.output.end(bytes);
      await ended;
    }
    f.duplex.end(bytes);
    await finished;
    if (!remoteFirst) {
      f.output.end(bytes);
      await ended;
    }
    assert.deepEqual(Buffer.concat(received), bytes);
    assert.deepEqual(Buffer.concat(f.inputs), bytes);
    assert.equal(f.ends(), 1);
    let verified = false;
    void f.duplex.completed.then(() => {
      verified = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(verified, false);
    assert.equal(f.aborts(), 0);
    const closed = once(f.duplex, "close");
    f.duplex.destroy();
    assert.equal(f.aborts(), 0);
    f.resolve();
    await f.duplex.completed;
    await closed;
    f.duplex.destroy();
    assert.equal(f.aborts(), 0);
  }
});

test("Node adapter bounds unread buffering and aborts uncertain destruction without leaking diagnostics", async () => {
  const f = fixture();
  f.output.write(Buffer.alloc(16384));
  f.output.write(Buffer.alloc(16384));
  f.duplex.read(0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(f.duplex.readableLength <= 32768);
  const failure = assert.rejects(f.duplex.completed, /Host connection failed/);
  f.duplex.destroy();
  await failure;
  assert.equal(f.aborts(), 1);
  assert.equal(f.ends(), 0);
});

test("Node adapter propagates post-EOF failure instead of reporting a successful connection", async () => {
  const f = fixture();
  f.duplex.resume();
  const ended = once(f.duplex, "end");
  f.output.end();
  await ended;
  const failure = assert.rejects(f.duplex.completed, /Host connection failed/);
  f.reject(Error("private details"));
  await failure;
  assert.equal(f.duplex.destroyed, true);
});
