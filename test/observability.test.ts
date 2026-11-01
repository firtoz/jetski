import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EventSink, StateStore } from "../src/core/contracts.js";
import { SandboxManager } from "../src/core/manager.js";
import { observeLifecycle } from "../src/core/observability.js";
import { OperationJournal } from "../src/core/operations.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

test("post-commit lifecycle events omit secrets and survive replay, rollback and sink failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-events-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const events: Parameters<EventSink["emit"]>[0][] = [];
  let at = 100;
  const observed = observeLifecycle(
    state,
    {
      emit(event) {
        events.push(event);
      },
    },
    () => at,
  );
  const journal = new OperationJournal(observed, () => at);
  const scope = { owner: "alice", sandbox: "sandbox" };
  const fence = await journal.generation(scope);
  await journal.admit(fence, "command", "execute", {
    password: "secret-input",
  });
  await journal.claim(fence, "command");
  at = 250;
  await journal.finish(fence, "command", {
    phase: "succeeded",
    result: "secret-output",
    error: "secret-error",
  });
  assert.deepEqual(
    events.map((event) => event.details),
    [
      {
        from: null,
        to: "queued",
        generation: 1,
        operationId: "command",
        kind: "execute",
        elapsedMs: 0,
      },
      {
        from: "queued",
        to: "running",
        generation: 1,
        operationId: "command",
        kind: "execute",
        elapsedMs: 0,
      },
      {
        from: "running",
        to: "succeeded",
        generation: 1,
        operationId: "command",
        kind: "execute",
        elapsedMs: 150,
      },
    ],
  );
  assert.doesNotMatch(JSON.stringify(events), /secret-/);
  assert.ok(
    events.every(
      (event) =>
        event.type === "operation.phase" && event.scope.owner === "alice",
    ),
  );
  await journal.admit(fence, "command", "execute", {
    password: "secret-input",
  });
  assert.equal(events.length, 3, "replay is not another transition");
  await assert.rejects(
    observed.transaction((tx) => {
      tx.put("sandbox/alice/rolled-back", { phase: "running", generation: 1 });
      throw Error("rollback");
    }),
  );
  assert.equal(events.length, 3);
  await observed.transaction((tx) => {
    tx.put("sandbox/alice/net", { phase: "starting", generation: 1 });
    tx.put("sandbox/alice/net", { phase: "running", generation: 1 });
    tx.put("private-input/alice/net", { phase: "secret-phase" });
  });
  assert.equal(events.length, 4);
  assert.deepEqual(events[3]?.details, {
    from: null,
    to: "running",
    generation: 1,
  });
  const broken = observeLifecycle(state, {
    emit() {
      throw Error("sink offline");
    },
  });
  await broken.transaction((tx) =>
    tx.put("sandbox/alice/net", { phase: "stopped", generation: 1 }),
  );
  assert.equal(
    await state.transaction(
      (tx) => tx.get<{ phase: string }>("sandbox/alice/net")?.phase,
    ),
    "stopped",
  );
  const asyncBroken = observeLifecycle(state, {
    async emit() {
      throw Error("async sink offline");
    },
  });
  await asyncBroken.transaction((tx) =>
    tx.put("sandbox/alice/async", { phase: "queued", generation: 1 }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const lostAck: StateStore = {
    async transaction(body) {
      await state.transaction(body);
      throw Error("lost commit ACK");
    },
  };
  await assert.rejects(
    observeLifecycle(lostAck, {
      emit(event) {
        events.push(event);
      },
    }).transaction((tx) =>
      tx.put("sandbox/alice/net", { phase: "deleted", generation: 1 }),
    ),
  );
  assert.equal(
    events.length,
    4,
    "uncertain acknowledgement is not emitted as confirmed",
  );
  assert.equal(
    await state.transaction(
      (tx) => tx.get<{ phase: string }>("sandbox/alice/net")?.phase,
    ),
    "deleted",
  );
});

test("manager composes optional observations without provider effects during admission", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-manager-events-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const events: Parameters<EventSink["emit"]>[0][] = [];
  const image = "example/linux@sha256:" + "a".repeat(64);
  const unexpected = async (): Promise<never> => {
    throw Error("Unexpected provider effect");
  };
  const manager = new SandboxManager(
    state,
    {
      capabilities: () => ({
        kind: "machine-host",
        architecture: "x86_64",
        rootlessPodman: true,
      }),
      allocate: unexpected,
      inspect: unexpected,
      retire: unexpected,
    },
    { request: unexpected },
    new LocalCheckpointStore(join(directory, "objects")),
    {
      poolId: "pool",
      approvedImages: [image],
      events: {
        emit(event) {
          events.push(event);
        },
      },
    },
  );
  const sandbox = randomUUID(),
    operation = randomUUID();
  await manager.create("alice", sandbox, image, operation);
  await manager.create("alice", sandbox, image, operation);
  assert.deepEqual(
    events.map((event) => event.type),
    ["operation.phase", "sandbox.phase"],
  );
  assert.ok(events.every((event) => event.scope.sandbox === sandbox));
  assert.equal(
    (await manager.get({ owner: "alice", sandbox }))?.phase,
    "queued",
  );
});
