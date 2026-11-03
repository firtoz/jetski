import assert from "node:assert/strict";
import test from "node:test";
import type { CheckpointStore } from "../src/core/contracts.js";
import {
  observeCheckpointStore,
  observeHostTimings,
  type StageTiming,
  timeStage,
} from "../src/core/timing.js";
import { hostControlArguments } from "../src/transport/host-backend.js";

test("timing cannot change success, original rejection or disabled work", async () => {
  const timings: StageTiming[] = [];
  const secret = Error("private failure");
  assert.equal(await timeStage(undefined, "work", async () => 42), 42);
  assert.equal(
    await timeStage(
      () => {
        throw Error("sink");
      },
      "work",
      async () => 42,
    ),
    42,
  );
  await assert.rejects(
    timeStage(
      (t) => timings.push(t),
      "work",
      async () => {
        throw secret;
      },
    ),
    (error) => error === secret,
  );
  assert.equal(timings[0]?.outcome, "error");
  assert.ok(timings[0]!.elapsedMs >= 0);
  assert.equal(JSON.stringify(timings).includes("private failure"), false);
});

test("host diagnostics are bounded and allowlisted, never arbitrary stderr", () => {
  const records: StageTiming[] = [];
  const valid =
    'JETSKI-STAGE/1:{"stage":"archive.restore","elapsedMs":12,"outcome":"observed","secret":"hidden"}';
  observeHostTimings(
    [
      "credential-secret",
      "JETSKI-STAGE/1:{",
      'JETSKI-STAGE/1:{"stage":"password","elapsedMs":1,"outcome":"ok"}',
      valid,
      ...Array(100).fill(valid),
    ].join("\n"),
    (value) => records.push(value),
  );
  assert.equal(records.length, 62);
  assert.deepEqual(records[0], {
    stage: "archive.restore",
    elapsedMs: 12,
    outcome: "observed",
  });
  assert.equal(JSON.stringify(records).includes("secret"), false);
  assert.equal(hostControlArguments().includes("JETSKI_HOST_TIMING=1"), false);
  assert.equal(
    hostControlArguments({ kind: "python" }, true).includes(
      "JETSKI_HOST_TIMING=1",
    ),
    true,
  );
});

test("store observation preserves capabilities, receiver and lazy stream closure", async () => {
  const records: StageTiming[] = [];
  let consumed = 0,
    closed = false;
  const store: CheckpointStore = {
    verificationConcurrency: 2,
    async put() {
      throw Error("unused");
    },
    async head() {
      assert.equal(this, store);
      return undefined;
    },
    async delete() {},
    async *read() {
      try {
        consumed++;
        yield new Uint8Array([1]);
        consumed++;
        yield new Uint8Array([2]);
      } finally {
        closed = true;
      }
    },
    async *list() {},
  };
  const observed = observeCheckpointStore(store, (value) =>
    records.push(value),
  );
  assert.equal(observed.verificationConcurrency, 2);
  assert.equal(observed.putBuffer, undefined);
  assert.equal(observed.verifyRanges, undefined);
  await observed.head({ owner: "owner", sandbox: "sandbox", id: "object" });
  const source = observed.read({
    owner: "owner",
    sandbox: "sandbox",
    id: "object",
  });
  assert.equal(consumed, 0);
  for await (const _part of source) break;
  assert.equal(consumed, 1);
  assert.equal(closed, true);
  assert.equal(records.at(-1)?.outcome, "error");
});
