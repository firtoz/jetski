import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HostProvider } from "../src/core/contracts.js";
import { SandboxManager } from "../src/core/manager.js";
import { PoolJournal } from "../src/core/pool.js";
import type { HostTransport } from "../src/core/transport.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

function barrier(count: number) {
  let observed = 0;
  let reached!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    ready,
    release,
    async enter() {
      if (++observed === count) reached();
      await released;
    },
  };
}

test("bounded parallel startup reserves only demand and preserves reservation replay", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  const pool = new PoolJournal(state, "pool", Date.now, randomUUID, 3);
  for (const id of ["first", "second"])
    await pool.enqueue("owner", randomUUID(), id, null);
  const [first, replay] = await Promise.all([
    pool.reserveBatch("owner", 2),
    pool.reserveBatch("owner", 2),
  ]);
  assert.equal(first.length, 2);
  assert.deepEqual(first, replay);
  assert.equal((await pool.inspect("owner")).length, 2);
  assert.equal(new Set(first.map((slot) => slot.allocationId)).size, 2);
  const one = randomUUID(),
    two = randomUUID();
  await pool.enqueue("cancel-race", one, "first", null);
  await pool.enqueue("cancel-race", two, "second", null);
  const batch = await pool.reserveBatch("cancel-race", 2);
  assert.equal(
    (await pool.dispatchAllocation(batch[0]!.id, "cancel-race"))?.dispatched,
    true,
  );
  await state.transaction((tx) =>
    pool.cancelQueuedIn(tx, "cancel-race", two, "second", null),
  );
  assert.equal(
    await pool.dispatchAllocation(batch[1]!.id, "cancel-race"),
    undefined,
    "a cancelled ticket must not start an extra host already covered by an admitted allocation",
  );
  await assert.rejects(pool.reserveBatch("owner", 0), /concurrency/);
  await assert.rejects(pool.reserveBatch("owner", 17), /concurrency/);
});

test("two hosts bootstrap and restore independently without bypassing per-host assignment fences", {
  timeout: 5000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-parallel-start-"));
  const state = new SqliteState(":memory:");
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const boots = barrier(2),
    creates = barrier(2);
  t.after(() => {
    boots.release();
    creates.release();
  });
  const allocations: string[] = [];
  let delayed = false;
  const provider: HostProvider = {
    capabilities: () => ({
      kind: "machine-host",
      architecture: "x86_64",
      rootlessPodman: true,
    }),
    allocate: async (input) => {
      allocations.push(input.operationId);
      return { id: input.operationId, allocationId: input.operationId };
    },
    inspect: async (host) => {
      if (host === allocations[1] && !delayed) {
        delayed = true;
        return { state: "starting" };
      }
      await boots.enter();
      return { state: "ready" };
    },
    retire: async () => {},
  };
  const claimed: string[] = [];
  const transport: HostTransport = {
    request: async (host, request) => {
      if (request.action === "claim") claimed.push(host);
      if (request.action === "create") await creates.enter();
      return { version: 1, id: request.id, result: {} };
    },
  };
  const image = "example/linux@sha256:" + "a".repeat(64);
  const manager = new SandboxManager(
    state,
    provider,
    transport,
    new LocalCheckpointStore(directory),
    {
      poolId: "pool",
      approvedImages: [image],
      hostsPerOwner: 3,
      hostStartupConcurrency: 2,
    },
  );
  const ids = [randomUUID(), randomUUID()];
  for (const id of ids) await manager.create("owner", id, image, randomUUID());
  const work = manager.reconcile("owner");
  void work.catch(() => {});
  await boots.ready;
  assert.equal(
    allocations.length,
    2,
    "both physical starts must precede either bootstrap finishing",
  );
  boots.release();
  await creates.ready;
  assert.equal(
    new Set(claimed).size,
    2,
    "both assignments must begin before either create finishes",
  );
  creates.release();
  await work;
  const sandboxes = await manager.list("owner");
  assert.ok(sandboxes.every((sandbox) => sandbox.phase === "running"));
  assert.equal(
    new Set(sandboxes.map((sandbox) => sandbox.lease?.machineId)).size,
    2,
  );
  await manager.reconcile("owner");
  assert.equal(
    allocations.length,
    2,
    "no residual demand may allocate an extra host",
  );
});
