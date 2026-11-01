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
    allocations = 0;
  const fault: StateStore = {
    async transaction(body) {
      const result = await state.transaction((tx) =>
        body({
          ...tx,
          put(key, value) {
            if (failQueue && key.startsWith("pool/pool/ticket/")) {
              failQueue = false;
              throw Error("queue write failed");
            }
            tx.put(key, value);
          },
        }),
      );
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
  const transport: HostTransport = {
    request: async (_host, request) => ({
      version: 1,
      id: request.id,
      result: { phase: "running" },
    }),
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
  await manager().reconcile(scope.owner);
  assert.equal(
    (await manager().get({ owner: scope.owner, sandbox: next }))?.phase,
    "running",
  );
  await manager().create(scope.owner, next, image, nextOperation);
  await manager().reconcile(scope.owner);
  assert.equal(allocations, 1);
});
