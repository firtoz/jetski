import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HostProvider, StateStore } from "../src/core/contracts.js";
import { SandboxManager } from "../src/core/manager.js";
import type { HostTransport } from "../src/core/transport.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

const image = `example/linux@sha256:${"a".repeat(64)}`;

test("creation rollback and lost ACK preserve one durable placement across restart and deletion", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-create-"));
  const path = join(directory, "state.sqlite");
  let state = new SqliteState(path);
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  let failQueue = true,
    loseAck = false,
    allocations = 0,
    failAssignment = false,
    loseAssignmentAck = false,
    creates = 0;
  const fault: StateStore = {
    async transaction(body) {
      let assignment = false;
      const result = await state.transaction((tx) =>
        body({
          ...tx,
          put(key, value) {
            if (failQueue && key.startsWith("pool/pool/ticket/")) {
              failQueue = false;
              throw Error("queue write failed");
            }
            if (
              failAssignment &&
              key.startsWith("sandbox/") &&
              value &&
              typeof value === "object" &&
              !Array.isArray(value) &&
              value.phase === "starting"
            ) {
              failAssignment = false;
              throw Error("assignment projection failed");
            }
            if (
              key.startsWith("sandbox/") &&
              value &&
              typeof value === "object" &&
              !Array.isArray(value) &&
              value.phase === "starting"
            )
              assignment = true;
            tx.put(key, value);
          },
        }),
      );
      if (assignment && loseAssignmentAck) {
        loseAssignmentAck = false;
        throw Error("assignment acknowledgement lost");
      }
      if (loseAck) {
        loseAck = false;
        throw Error("commit acknowledgement lost");
      }
      return result;
    },
  };
  const provider: HostProvider = {
    capabilities: () => ({
      kind: "machine-host",
      architecture: "x86_64",
      rootlessPodman: true,
    }),
    allocate: async (input) => {
      allocations++;
      return { id: "host", allocationId: input.operationId };
    },
    inspect: async () => ({ state: "ready" }),
    retire: async () => {},
  };
  let running = false;
  const transport: HostTransport = {
    request: async (_host, request) => {
      const payload = request.payload as {
        lease: import("../src/core/contracts.js").Json;
      };
      if (request.action === "create") {
        creates++;
        running = true;
      }
      const result =
        request.action === "inspect"
          ? {
              phase: "open",
              lease: payload.lease,
              runtime: running ? { phase: "running", image } : null,
            }
          : { phase: "running" };
      return { version: 1, id: request.id, result };
    },
  };
  const manager = (store: StateStore = state) =>
    new SandboxManager(
      store,
      provider,
      transport,
      new LocalCheckpointStore(join(directory, "objects")),
      { poolId: "pool", approvedImages: [image] },
    );
  const id = randomUUID(),
    operation = randomUUID(),
    scope = { owner: "alice", sandbox: id };
  await assert.rejects(
    manager(fault).create(scope.owner, id, image, operation),
    /queue write failed/,
  );
  assert.deepEqual(
    await state.transaction((tx) => tx.scan("")),
    [],
    "a queue failure must not leave admitted or visible work",
  );
  loseAck = true;
  await assert.rejects(
    manager(fault).create(scope.owner, id, image, operation),
    /acknowledgement lost/,
  );
  state.close();
  state = new SqliteState(path);
  assert.equal((await manager().get(scope))?.phase, "queued");
  await manager().deleteSandbox(scope, randomUUID());
  assert.equal(
    (await manager().create(scope.owner, id, image, operation)).phase,
    "deleted",
  );
  await manager().reconcile(scope.owner);
  assert.equal(
    allocations,
    0,
    "late create replay cannot revive cancelled placement",
  );
  const next = randomUUID(),
    nextOperation = randomUUID();
  loseAck = true;
  await assert.rejects(
    manager(fault).create(scope.owner, next, image, nextOperation),
    /acknowledgement lost/,
  );
  state.close();
  state = new SqliteState(path);
  failAssignment = true;
  await assert.rejects(
    manager(fault).reconcile(scope.owner),
    /assignment projection failed/,
  );
  const nextScope = { owner: scope.owner, sandbox: next };
  assert.equal((await manager().get(nextScope))?.phase, "queued");
  assert.equal(
    (await manager().operation(nextScope, nextOperation))?.phase,
    "queued",
  );
  const slots = await state.transaction((tx) => tx.scan("pool/pool/slot/"));
  assert.equal(slots.length, 1);
  assert.equal((slots[0]!.value as { phase: string }).phase, "idle");
  loseAssignmentAck = true;
  await assert.rejects(
    manager(fault).reconcile(scope.owner),
    /assignment acknowledgement lost/,
  );
  assert.equal((await manager().get(nextScope))?.phase, "starting");
  assert.equal(
    (await manager().operation(nextScope, nextOperation))?.phase,
    "running",
  );
  assert.equal(
    creates,
    0,
    "lost assignment ACK occurs before any workload RPC",
  );
  state.close();
  state = new SqliteState(path);
  await manager().reconcile(scope.owner);
  assert.equal((await manager().get(nextScope))?.phase, "running");
  assert.equal(
    creates,
    1,
    "restart resumes the recorded lease without duplicate creation",
  );
  await manager().create(scope.owner, next, image, nextOperation);
  await manager().reconcile(scope.owner);
  assert.equal(allocations, 1);
});
