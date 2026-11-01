import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CheckpointRegistry } from "../src/core/checkpoints.js";
import { DEFAULTS } from "../src/core/contracts.js";
import { CheckpointMaintenance } from "../src/core/maintenance.js";
import { SandboxManager } from "../src/core/manager.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

test("maintenance preserves grace and uncertain identities across restart, and fences generation changes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jetski-maintenance-"));
  let state = new SqliteState(join(dir, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(dir, { recursive: true, force: true });
  });
  let now = 1000,
    generation = 1,
    idle = true,
    fail = true;
  const scope = { owner: "owner", sandbox: "sandbox" };
  const calls: string[] = [];
  const open = () =>
    new CheckpointMaintenance(
      state,
      (_tx, scope) => (idle ? { ...scope, generation } : undefined),
      async (_fence, id) => {
        calls.push(id);
        if (fail) throw Error("Lost acknowledgment");
        return { deleted: 2 };
      },
      () => now,
    );
  let maintenance = open();
  await maintenance.run(scope);
  assert.equal(calls.length, 0);
  now += DEFAULTS.gcGraceMs - 1;
  await maintenance.run(scope);
  assert.equal(calls.length, 0);
  now++;
  idle = false;
  await maintenance.run(scope);
  assert.equal(calls.length, 0);
  idle = true;
  await assert.rejects(maintenance.run(scope), /Lost acknowledgment/);
  state.close();
  state = new SqliteState(join(dir, "state.sqlite"));
  maintenance = open();
  await maintenance.run(scope);
  assert.equal(calls.length, 1, "Durable retry backoff");
  now += 5 * 60_000;
  generation = 2;
  await assert.rejects(maintenance.run(scope), /generation changed/);
  assert.equal(calls.length, 1);
  generation = 1;
  fail = false;
  await maintenance.run(scope);
  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1]);
  const status = (await maintenance.status(scope)) as {
    attempt: null;
    last: { deleted: number };
    dueAt: number;
  };
  assert.equal(status.attempt, null);
  assert.equal(status.last.deleted, 2);
  assert.equal(status.dueAt, now + DEFAULTS.gcGraceMs);
  assert.equal(
    await maintenance.status({ ...scope, owner: "foreign" }),
    undefined,
  );
});

test("scheduled real collection removes only retired bytes and preserves retained data", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jetski-maintenance-real-"));
  const state = new SqliteState(join(dir, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(dir, { recursive: true, force: true });
  });
  let now = 1000;
  const objects = new LocalCheckpointStore(join(dir, "objects"));
  const registry = new CheckpointRegistry(state, objects, () => now);
  const fence = { owner: "owner", sandbox: "sandbox", generation: 1 };
  await registry.initialize(fence);
  const frames = [];
  for (const id of ["retired", "retained"]) {
    const bytes = Buffer.from(id);
    const info = await objects.put(
      { ...fence, id },
      (async function* () {
        yield bytes;
      })(),
      {
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    );
    frames.push(info);
    await registry.admit(fence, id, "writer");
    await registry.publish(fence, id, id, [info]);
  }
  await registry.retire(fence, "retired");
  const maintenance = new CheckpointMaintenance(
    state,
    () => fence,
    (f, id) => registry.collect(f, id),
    () => now,
  );
  await maintenance.run(fence);
  assert.ok(await objects.head(frames[0]!));
  now += DEFAULTS.gcGraceMs;
  await maintenance.run(fence);
  assert.equal(await objects.head(frames[0]!), undefined);
  assert.ok(await objects.head(frames[1]!));
  await maintenance.run(fence);
  const output = [];
  for await (const bytes of objects.read(frames[1]!)) output.push(bytes);
  assert.equal(Buffer.concat(output).toString(), "retained");
  await state.transaction((tx) =>
    tx.put("checkpoint-maintenance/owner/sandbox", { dueAt: 0 }),
  );
  await assert.rejects(maintenance.run(fence), /Ambiguous/);
});

test("manager returns a durable idle deadline for embedded alarms", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jetski-maintenance-deadline-"));
  const state = new SqliteState(join(dir, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(dir, { recursive: true, force: true });
  });
  const now = 1000,
    image = `example/linux@sha256:${"a".repeat(64)}`;
  const objects = new LocalCheckpointStore(join(dir, "objects"));
  const manager = new SandboxManager(
    state,
    {
      capabilities: () => ({
        kind: "machine-host",
        architecture: "x86_64",
        rootlessPodman: true,
      }),
      allocate: async () => {
        throw Error("No host allocation expected");
      },
      inspect: async () => ({ state: "absent" }),
      retire: async () => {},
    },
    {
      request: async () => {
        throw Error("No host execution expected");
      },
    },
    objects,
    {
      poolId: "pool",
      approvedImages: [image],
      automaticCollection: true,
      now: () => now,
    },
  );
  const id = crypto.randomUUID();
  await manager.create("owner", id, image, crypto.randomUUID());
  const registry = new CheckpointRegistry(state, objects, () => now);
  await registry.initialize({ owner: "owner", sandbox: id, generation: 1 });
  assert.equal(
    await manager.maintain("owner"),
    null,
    "Queued work has no idle maintenance deadline",
  );
  await state.transaction((tx) => {
    const key = `sandbox/owner/${id}`;
    const record = manager.getIn(tx, { owner: "owner", sandbox: id })!;
    tx.put(key, { ...record, phase: "stopped" });
  });
  assert.equal(await manager.maintain("owner"), now + DEFAULTS.gcGraceMs);
  assert.equal(
    await manager.maintain("owner"),
    now + DEFAULTS.gcGraceMs,
    "Repeated alarms preserve dueAt",
  );
  assert.equal(await manager.maintain("foreign"), null);
});
