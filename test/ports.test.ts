import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OperationJournal } from "../src/core/operations.js";
import { type PortContext, PortRegistry, tcpPort } from "../src/core/ports.js";
import { SqliteState } from "../src/state/sqlite.js";

test("port grants retain outcomes across restart and never follow a replacement assignment", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-ports-"));
  const path = join(directory, "state.sqlite");
  let state = new SqliteState(path);
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const scope = { owner: "alice", sandbox: "box" };
  const context: PortContext = {
    generation: 1,
    running: true,
    image: "image",
    lease: {
      owner: "alice",
      sandboxId: "box",
      machineId: "machine",
      poolId: "pool",
      slotId: "slot",
      assignmentId: "assignment",
      generation: 1,
    },
  };
  const build = () =>
    new PortRegistry(state, new OperationJournal(state), (_tx, request) => {
      assert.deepEqual(request, scope);
      return structuredClone(context);
    });
  await new OperationJournal(state).generation(scope);
  let ports = build();
  const id = randomUUID();
  const receipt = await ports.expose(scope, id, 8080);
  assert.equal(receipt.phase, "succeeded");
  assert.equal((await ports.authorize(scope, id)).port, 8080);
  state.close();
  state = new SqliteState(path);
  ports = build();
  assert.deepEqual(await ports.expose(scope, id, 8080), receipt);
  await assert.rejects(ports.expose(scope, id, 8081), /identity conflict/);
  await assert.rejects(
    ports.authorize({ owner: "bob", sandbox: "box" }, id),
    /unavailable/,
  );
  context.running = false;
  await assert.rejects(ports.authorize(scope, id), /unavailable/);
  assert.equal((await ports.status(scope, id)).available, false);
  context.running = true;
  context.lease = { ...context.lease!, assignmentId: "replacement" };
  await assert.rejects(ports.authorize(scope, id), /unavailable/);
  context.generation = 2;
  context.lease = { ...context.lease, generation: 2 };
  await new OperationJournal(state).advance({ ...scope, generation: 1 });
  assert.deepEqual(await ports.expose(scope, id, 8080), receipt);
  assert.equal((await ports.status(scope, id)).available, false);
  const next = randomUUID();
  await ports.expose(scope, next, 8080);
  assert.equal((await ports.status(scope, next)).available, true);
  const revoked = await ports.revoke(scope, next, "revoke");
  assert.deepEqual(await ports.revoke(scope, next, "revoke"), revoked);
  await assert.rejects(ports.revoke(scope, id, "revoke"), /identity conflict/);
  await assert.rejects(ports.authorize(scope, next), /unavailable/);
  await ports.expose(scope, next, 8080);
  assert.equal((await ports.status(scope, next)).revoked, true);
  await assert.rejects(
    ports.expose(scope, "revoke", 8080),
    /identity conflict/,
  );
  await ports.revoke(scope, id, "old-revoke");
  for (const invalid of [0, 65536, -1, 1.5, NaN, Infinity, "8080", null])
    assert.throws(() => tcpPort(invalid));
});

test("port admission and revocation serialize with a strict active bound", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-port-limit-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const scope = { owner: "alice", sandbox: "box" };
  const operations = new OperationJournal(state);
  await operations.generation(scope);
  const ports = new PortRegistry(state, operations, () => ({
    generation: 1,
    running: true,
    image: "image",
    lease: {
      owner: "alice",
      sandboxId: "box",
      machineId: "host",
      poolId: "pool",
      slotId: "slot",
      assignmentId: "assignment",
      generation: 1,
    },
  }));
  const outcomes = await Promise.allSettled(
    Array.from({ length: 65 }, (_, index) =>
      ports.expose(scope, `port-${index}`, 8000 + index),
    ),
  );
  assert.equal(
    outcomes.filter((item) => item.status === "fulfilled").length,
    64,
  );
  await ports.revoke(scope, "port-0", "revoke");
  await ports.expose(scope, "replacement", 9000);
  assert.equal((await ports.status(scope, "port-0")).available, false);
  assert.equal((await ports.status(scope, "replacement")).available, true);
});
