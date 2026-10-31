import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { HostConnection } from "../src/core/host-stream.js";
import { OperationJournal } from "../src/core/operations.js";
import { type PortContext, PortRegistry } from "../src/core/ports.js";
import { StreamCoordinator } from "../src/core/streams.js";
import type { HostTransport } from "../src/core/transport.js";
import { SqliteState } from "../src/state/sqlite.js";

const scope = { owner: "alice", sandbox: "box" };
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "jetski-streams-"));
  const path = join(dir, "state.sqlite"),
    state = new SqliteState(path);
  t.after(async () => {
    state.close();
    await rm(dir, { recursive: true, force: true });
  });
  const operations = new OperationJournal(state);
  await operations.generation(scope);
  const context: PortContext = {
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
  };
  const ports = new PortRegistry(state, operations, () => context);
  await ports.expose(scope, "port", 8080);
  let opens = 0,
    cancels = 0;
  let observed = { phase: "dispatched", delivery: "unknown" };
  const control: HostTransport = {
    async request(_host, req) {
      if (req.action === "stream-cancel") cancels++;
      return {
        version: 1,
        id: req.id,
        result: { id: req.id, port: 8080, ...observed },
      };
    },
  };
  let now = Date.now();
  const build = (open: () => Promise<HostConnection>, db = state) =>
    new StreamCoordinator(
      db,
      new PortRegistry(db, new OperationJournal(db), () => context),
      new OperationJournal(db),
      control,
      {
        async open() {
          opens++;
          return open();
        },
      },
      () => now,
    );
  return {
    state,
    path,
    operations,
    ports,
    context,
    control,
    build,
    setNow(value: number) {
      now = value;
    },
    setObserved(value: typeof observed) {
      observed = value;
    },
    get opens() {
      return opens;
    },
    get cancels() {
      return cancels;
    },
  };
}
function connection() {
  let resolve!: () => void,
    reject!: (error: Error) => void,
    aborted = 0,
    sends = 0;
  const completed = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void completed.catch(() => {});
  const wire: HostConnection = {
    completed,
    async send() {
      sends++;
    },
    async end() {},
    abort() {
      aborted++;
      reject(Error("aborted"));
    },
    output: {
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array([1, 0, 255]);
        resolve();
      },
    },
  };
  return {
    wire,
    resolve,
    get aborted() {
      return aborted;
    },
    get sends() {
      return sends;
    },
  };
}
test("stream admission survives SQLite reopen and uncertain dispatch never replays", async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  const first = f.build(async () => {
    throw Error("lost acknowledgement");
  });
  await assert.rejects(first.open(scope, "port", id), /acknowledgement/);
  assert.equal((await first.status(scope, id)).phase, "uncertain");
  const reopened = new SqliteState(f.path);
  t.after(() => reopened.close());
  const next = f.build(async () => connection().wire, reopened);
  await assert.rejects(next.open(scope, "port", id), /already admitted/);
  await assert.rejects(
    next.status({ ...scope, owner: "bob" }, id),
    /unavailable/,
  );
  await assert.rejects(
    next.open({ ...scope, owner: "bob" }, "port", randomUUID()),
    /unavailable/,
  );
  assert.equal(f.opens, 1);
  f.setObserved({ phase: "cancelled", delivery: "unknown" });
  assert.equal((await next.reconcile(scope, id)).phase, "cancelled");
  assert.equal(f.cancels, 0);
  assert.equal((await f.operations.get(scope, id))?.phase, "uncertain");
});
test("completed streams retain outcomes and revoked permissions abort idle connections", async (t) => {
  const f = await fixture(t),
    source = connection();
  const coordinator = f.build(async () => source.wire),
    id = randomUUID();
  const live = await coordinator.open(scope, "port", id);
  const bytes: number[] = [];
  await live.send(new Uint8Array([1]));
  await live.end();
  for await (const part of live.output) bytes.push(...part);
  await live.completed;
  assert.deepEqual(bytes, [1, 0, 255]);
  assert.equal((await coordinator.status(scope, id)).phase, "closed");
  assert.equal((await f.operations.get(scope, id))?.phase, "succeeded");
  const idle = connection(),
    next = f.build(async () => idle.wire),
    nextId = randomUUID();
  const active = await next.open(scope, "port", nextId);
  await f.ports.revoke(scope, "port", "revoke");
  await assert.rejects(
    Promise.race([
      active.completed,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(Error("watch did not abort")),
          2000,
        );
        timer.unref();
      }),
    ]),
    /aborted/,
  );
  assert.equal(idle.aborted, 1);
  assert.equal((await next.status(scope, nextId)).phase, "uncertain");
  await assert.rejects(active.send(new Uint8Array([1])));
  assert.equal(idle.sends, 0);
});
test("revocation while transport admission is pending never yields usable connection", async (t) => {
  const f = await fixture(t),
    source = connection(),
    id = randomUUID();
  let release!: (value: HostConnection) => void;
  const pending = new Promise<HostConnection>((resolve) => {
    release = resolve;
  });
  const coordinator = f.build(() => pending);
  const opening = coordinator.open(scope, "port", id);
  while (!f.opens) await new Promise((resolve) => setTimeout(resolve, 1));
  await f.ports.revoke(scope, "port", "revoke");
  release(source.wire);
  await assert.rejects(opening, /authority withdrawn/);
  assert.ok(source.aborted >= 1);
  assert.equal((await coordinator.status(scope, id)).phase, "uncertain");
});
test("stream capacity counts unresolved outcomes and replacement cannot receive stale completion", async (t) => {
  const f = await fixture(t);
  const coordinator = f.build(async () => {
    throw Error("uncertain");
  });
  for (let i = 0; i < 64; i++)
    await assert.rejects(
      coordinator.open(scope, "port", randomUUID()),
      /uncertain/,
    );
  await assert.rejects(coordinator.open(scope, "port", randomUUID()), /limit/);
  assert.equal(f.opens, 64);
  const other = await fixture(t),
    source = connection(),
    id = randomUUID();
  const running = other.build(async () => source.wire);
  const live = await running.open(scope, "port", id);
  await other.operations.advance({ ...scope, generation: 1 });
  other.context.generation = 2;
  source.resolve();
  await assert.rejects(live.completed, /not authoritative/);
  assert.equal((await running.status(scope, id)).phase, "uncertain");
  assert.equal((await other.operations.get(scope, id))?.phase, "running");
});

test("lost acknowledgement recovers exact host completion before sending cancellation", async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  const first = f.build(async () => {
    throw Error("lost acknowledgement");
  });
  await assert.rejects(first.open(scope, "port", id));
  f.setObserved({ phase: "closed", delivery: "complete" });
  const restarted = f.build(async () => {
    throw Error("must not reopen");
  });
  await restarted.reconcileOwner(scope.owner);
  assert.equal((await restarted.status(scope, id)).phase, "closed");
  assert.equal((await f.operations.get(scope, id))?.phase, "succeeded");
  assert.equal(f.opens, 1);
  assert.equal(f.cancels, 0);
});
test("another controller preserves a valid connection and cancels an expired owner without replay", async (t) => {
  const f = await fixture(t),
    source = connection(),
    id = randomUUID();
  const first = f.build(async () => source.wire);
  const live = await first.open(scope, "port", id);
  const restarted = f.build(async () => {
    throw Error("must not reopen");
  });
  await restarted.reconcileOwner(scope.owner);
  assert.equal(f.cancels, 0);
  f.setNow((await first.status(scope, id)).validUntil + 1);
  await restarted.reconcileOwner(scope.owner);
  assert.equal(f.cancels, 1);
  await assert.rejects(live.send(new Uint8Array([1])), /authority withdrawn/);
  await assert.rejects(live.completed);
  assert.equal(source.sends, 0);
  f.setObserved({ phase: "cancelled", delivery: "unknown" });
  await restarted.reconcileOwner(scope.owner);
  assert.equal((await restarted.status(scope, id)).phase, "cancelled");
  assert.equal(f.opens, 1);
});

test("host completion cannot discard bytes still buffered by a live controller", async (t) => {
  const f = await fixture(t),
    source = connection(),
    id = randomUUID();
  const first = f.build(async () => source.wire);
  const live = await first.open(scope, "port", id);
  f.setObserved({ phase: "closed", delivery: "complete" });
  const other = f.build(async () => {
    throw Error("must not reopen");
  });
  await other.reconcileOwner(scope.owner);
  assert.equal((await other.status(scope, id)).phase, "open");
  const received: number[] = [];
  for await (const bytes of live.output) received.push(...bytes);
  await live.completed;
  assert.deepEqual(received, [1, 0, 255]);
  assert.equal((await first.status(scope, id)).phase, "closed");
  assert.equal(source.aborted, 0);
});

test("missing host admission installs a tombstone and waits for independent observation", async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  const coordinator = f.build(async () => {
    throw Error("request never reached host");
  });
  await assert.rejects(coordinator.open(scope, "port", id));
  let tombstone = false,
    cancellations = 0;
  f.control.request = async (_host, request) => {
    if (request.action === "stream-cancel") {
      cancellations++;
      tombstone = true;
    } else if (!tombstone) throw Error("host stream absent");
    return {
      version: 1,
      id: request.id,
      result: { id, port: null, phase: "cancelled", delivery: "unknown" },
    };
  };
  await assert.rejects(coordinator.reconcile(scope, id), /host stream absent/);
  assert.equal(cancellations, 1);
  const pending = await coordinator.status(scope, id);
  assert.equal(pending.cancelRequested, true);
  assert.equal(pending.phase, "uncertain");
  const reopened = new SqliteState(f.path);
  t.after(() => reopened.close());
  const next = f.build(async () => {
    throw Error("must not reopen");
  }, reopened);
  assert.equal((await next.reconcile(scope, id)).phase, "cancelled");
  await assert.rejects(next.open(scope, "port", id), /already admitted/);
  assert.equal(f.opens, 1);
});
test("outage keeps durable cancellation intent without claiming cleanup", async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  const coordinator = f.build(async () => {
    throw Error("uncertain");
  });
  await assert.rejects(coordinator.open(scope, "port", id));
  f.control.request = async () => {
    throw Error("provider unavailable");
  };
  await assert.rejects(coordinator.reconcile(scope, id), AggregateError);
  assert.equal((await coordinator.status(scope, id)).cancelRequested, true);
  assert.equal((await coordinator.status(scope, id)).phase, "uncertain");
  assert.equal((await f.operations.get(scope, id))?.phase, "uncertain");
});

test("shutdown requires terminal stream proof and leaves other assignments untouched", async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  const coordinator = f.build(async () => {
    throw Error("uncertain");
  });
  await assert.rejects(coordinator.open(scope, "port", id));
  f.context.running = false;
  await assert.rejects(
    coordinator.settleStopped(scope, f.context.lease!),
    /termination unverified/,
  );
  assert.equal((await coordinator.status(scope, id)).phase, "uncertain");
  f.setObserved({ phase: "cancelled", delivery: "unknown" });
  await coordinator.settleStopped(scope, {
    ...f.context.lease!,
    assignmentId: "another",
  });
  assert.equal((await coordinator.status(scope, id)).phase, "uncertain");
  await coordinator.settleStopped(scope, f.context.lease!);
  assert.equal((await coordinator.status(scope, id)).phase, "cancelled");
  assert.equal((await f.operations.get(scope, id))?.phase, "uncertain");
});
