import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULTS, type HostProvider } from "../src/core/contracts.js";
import { SandboxManager } from "../src/core/manager.js";
import { PoolJournal } from "../src/core/pool.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

const image = "example/linux@sha256:" + "a".repeat(64);
for (const dispatched of [false, true])
  test(`queued deletion accounts for allocation: dispatched=${dispatched}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "jetski-cancel-"));
    const state = new SqliteState(join(directory, "state.sqlite"));
    t.after(async () => {
      state.close();
      await rm(directory, { recursive: true, force: true });
    });
    const objects = new LocalCheckpointStore(join(directory, "objects"));
    let now = 1,
      calls = 0,
      retirements = 0,
      commands = 0;
    const physical = new Set<string>();
    const provider: HostProvider = {
      capabilities: () => ({
        kind: "machine-host",
        architecture: "x86_64",
        rootlessPodman: true,
      }),
      allocate: async (input) => {
        calls++;
        physical.add(input.operationId);
        if (calls === 1) throw Error("allocation ACK lost");
        return { id: "owned-host", allocationId: input.operationId };
      },
      inspect: async () => ({ state: "ready" }),
      retire: async (_id, allocationId) => {
        assert.ok(physical.has(allocationId));
        retirements++;
      },
    };
    const transport = {
      request: async () => {
        commands++;
        throw Error("Cancelled sandbox must never reach host");
      },
    };
    const options = { poolId: "pool", approvedImages: [image], now: () => now };
    let manager = new SandboxManager(
      state,
      provider,
      transport,
      objects,
      options,
    );
    const scope = { owner: "alice", sandbox: randomUUID() },
      creation = randomUUID(),
      deletion = randomUUID();
    await manager.create(scope.owner, scope.sandbox, image, creation);
    const pool = new PoolJournal(state, "pool", () => now);
    if (dispatched)
      await assert.rejects(manager.reconcile("alice"), /allocation ACK lost/);
    else
      assert.ok(
        await pool.reserve("alice"),
        "reserve without dispatch to exercise cancellation window",
      );
    await manager.deleteSandbox(scope, deletion);
    assert.equal((await manager.operation(scope, creation))?.phase, "failed");
    assert.equal(
      (await manager.operation(scope, deletion))?.phase,
      "succeeded",
    );
    manager = new SandboxManager(state, provider, transport, objects, options);
    await manager.reconcile("alice");
    await manager.deleteSandbox(scope, deletion);
    await manager.create(scope.owner, scope.sandbox, image, creation);
    await manager.reconcile("alice");
    assert.equal((await manager.get(scope))?.phase, "deleted");
    assert.equal(commands, 0);
    assert.equal(physical.size, dispatched ? 1 : 0);
    assert.equal(calls, dispatched ? 2 : 0);
    now += DEFAULTS.idleMs;
    await manager.reconcile("alice");
    assert.equal(retirements, dispatched ? 1 : 0);
    assert.ok(
      (await pool.inspect("alice")).every((slot) => slot.phase === "retired"),
    );
  });

test("command cancellation survives controller restart before dispatch and after lost ACK", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-command-cancel-"));
  const path = join(directory, "state.sqlite");
  let state = new SqliteState(path);
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const objects = new LocalCheckpointStore(join(directory, "objects"));
  const provider: HostProvider = {
    capabilities: () => ({
      kind: "machine-host",
      architecture: "x86_64",
      rootlessPodman: true,
    }),
    allocate: async (input) => ({
      id: "host",
      allocationId: input.operationId,
    }),
    inspect: async () => ({ state: "ready" }),
    retire: async () => {},
  };
  let statusFails = false,
    loseAck = false,
    cancellations = 0,
    starts = 0;
  let phase = "running";
  const transport = {
    request: async (_host: string, request: { id: string; action: string }) => {
      if (request.action === "command-start") starts++;
      if (request.action === "command-status" && statusFails)
        throw Error("status unreachable");
      if (request.action === "command-cancel") {
        cancellations++;
        phase = "cancelled";
        if (loseAck) {
          loseAck = false;
          throw Error("cancel ACK lost");
        }
      }
      return { version: 1 as const, id: request.id, result: { phase } };
    },
  };
  const options = { poolId: "pool", approvedImages: [image] };
  let manager = new SandboxManager(
    state,
    provider,
    transport,
    objects,
    options,
  );
  const scope = { owner: "alice", sandbox: randomUUID() },
    command = randomUUID();
  await manager.create(scope.owner, scope.sandbox, image, randomUUID());
  await manager.reconcile(scope.owner);
  await manager.startCommand(scope, command, ["sleep", "120"]);
  await assert.rejects(
    manager.cancelCommand({ ...scope, owner: "other" }, command),
    /unavailable/,
  );
  statusFails = true;
  await assert.rejects(
    manager.cancelCommand(scope, command),
    /status unreachable/,
  );
  assert.equal(cancellations, 0);
  state.close();
  state = new SqliteState(path);
  manager = new SandboxManager(state, provider, transport, objects, options);
  statusFails = false;
  loseAck = true;
  await assert.rejects(manager.reconcile(scope.owner), /cancel ACK lost/);
  assert.equal(cancellations, 1);
  state.close();
  state = new SqliteState(path);
  manager = new SandboxManager(state, provider, transport, objects, options);
  await manager.reconcile(scope.owner);
  statusFails = true;
  assert.deepEqual(await manager.cancelCommand(scope, command), {
    phase: "cancelled",
  });
  assert.equal(
    cancellations,
    1,
    "observed terminal outcome does not repeat cancellation",
  );
  assert.equal(starts, 1, "recovery must never restart the command");
});
