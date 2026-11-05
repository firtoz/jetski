import assert from "node:assert/strict";
import test from "node:test";
import {
  type BoxdClient,
  type BoxdExec,
  BoxdHostProvider,
  type BoxdMachine,
} from "../src/providers/boxd.js";
import { SqliteState } from "../src/state/sqlite.js";
import { BoxdControlChannel, BoxdTransport } from "../src/transport/boxd.js";

function notFound() {
  const error = Error("missing");
  error.name = "NotFoundError";
  return error;
}
function fixture() {
  const machines = new Map<string, BoxdMachine>();
  let creates = 0,
    deletes = 0,
    loseCreate = false,
    loseDelete = false;
  const client: BoxdClient = {
    machines: {
      async create(input) {
        creates++;
        assert.equal(input.isolated, true);
        assert.equal(input.config.ssh, false);
        assert.ok(input.deleteAfter <= 3600);
        const m = {
          id: "host",
          name: input.name,
          status: "running",
          labels: input.labels,
        };
        machines.set(m.id, m);
        if (loseCreate) {
          loseCreate = false;
          throw Error("create acknowledgement lost");
        }
        return m;
      },
      async get(id) {
        const m = [...machines.values()].find(
          (m) => m.id === id || m.name === id,
        );
        if (!m) throw notFound();
        return m;
      },
      async delete(id) {
        deletes++;
        machines.delete(id);
        if (loseDelete) {
          loseDelete = false;
          throw Error("delete acknowledgement lost");
        }
      },
      async waitUntilReady(id) {
        return this.get(id);
      },
      streamExec() {
        throw Error("Not used by provider tests");
      },
    },
  };
  return {
    client,
    machines,
    get creates() {
      return creates;
    },
    get deletes() {
      return deletes;
    },
    loseCreate() {
      loseCreate = true;
    },
    loseDelete() {
      loseDelete = true;
    },
  };
}
test("Boxd allocation acknowledges existing work after lost create ACK and fences owner/name/labels", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  const f = fixture();
  let bootstraps = 0;
  const provider = new BoxdHostProvider(
    state,
    f.client,
    "pool",
    async () => {
      bootstraps++;
    },
    { now: () => 1000 },
  );
  const input = {
    owner: "alice",
    operationId: "operation",
    expiresAt: 3600000,
  };
  f.loseCreate();
  await assert.rejects(provider.allocate(input), /acknowledgement/);
  const allocation = await provider.allocate(input);
  assert.equal(f.creates, 1);
  assert.equal(allocation.id, "host");
  await assert.rejects(
    provider.allocate({ ...input, owner: "bob" }),
    /identity/,
  );
  assert.equal((await provider.inspect("host")).state, "ready");
  assert.equal(bootstraps, 1);
  f.machines.get("host")!.labels["jetski-pool"] = "foreign";
  await assert.rejects(provider.retire("host", "operation"), /ownership/);
  assert.equal(f.deletes, 0);
});
test("Boxd retirement retains authority after lost ACK and confirms absence before success", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  const f = fixture();
  const provider = new BoxdHostProvider(
    state,
    f.client,
    "pool",
    async () => {},
    { now: () => 1000 },
  );
  await provider.allocate({
    owner: "alice",
    operationId: "operation",
    expiresAt: 3600000,
  });
  f.loseDelete();
  await assert.rejects(provider.retire("host", "operation"), /acknowledgement/);
  await provider.retire("host", "operation");
  await provider.retire("host", "operation");
  assert.equal(f.deletes, 1);
  assert.equal((await provider.inspect("host")).state, "absent");
  await assert.rejects(provider.owned("host"), /owned/);
});
test("Boxd transport preserves stdin bytes, bounds output and never replays uncertain execution", async () => {
  let opened = 0,
    closed = 0,
    exitCode = 0,
    outputBytes: Uint8Array | undefined;
  const input: Uint8Array[] = [];
  const f = fixture();
  f.client.machines.streamExec = () => {
    opened++;
    input.length = 0;
    const stdout = (async function* () {
      if (outputBytes) yield outputBytes;
      else {
        const request = JSON.parse(Buffer.concat(input).toString());
        yield Buffer.from(
          JSON.stringify({
            version: 1,
            id: request.id,
            result: { exact: "雪" },
          }),
        );
      }
    })();
    const stream: BoxdExec = {
      stdout,
      stderr: (async function* () {})(),
      write(bytes) {
        input.push(
          typeof bytes === "string"
            ? Buffer.from(bytes)
            : new Uint8Array(bytes),
        );
      },
      end() {},
      wait: async () => exitCode,
      close() {
        closed++;
      },
      [Symbol.asyncIterator]() {
        return stdout[Symbol.asyncIterator]();
      },
    };
    return stream;
  };
  const channel = new BoxdControlChannel(f.client, async () => {}),
    transport = new BoxdTransport(channel);
  const request = {
    version: 1 as const,
    id: "operation",
    action: "status",
    payload: null,
  };
  assert.deepEqual((await transport.request("host", request)).result, {
    exact: "雪",
  });
  assert.equal(opened, 1);
  assert.equal(closed, 1);
  exitCode = 1;
  await assert.rejects(transport.request("host", request), (error: unknown) => {
    assert.ok(error instanceof Error && "details" in error);
    assert.deepEqual(error.details, {
      provider: "boxd",
      code: "remote-exit",
      exitCode: 1,
    });
    return true;
  });
  assert.equal(opened, 2);
  exitCode = 0;
  outputBytes = new Uint8Array(2 * 1024 * 1024 + 1);
  await assert.rejects(
    transport.request("host", request),
    /completion unknown/,
  );
  assert.equal(opened, 3);
  assert.equal(closed, 3);
  await assert.rejects(
    transport.request("host", {
      ...request,
      payload: "x".repeat(2 * 1024 * 1024),
    }),
    /completion unknown/,
  );
  assert.equal(opened, 3);
});

test("native boxd power observes lost ACKs without replay and denies foreign owner transitions", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  const f = fixture();
  let sleeps = 0,
    wakes = 0;
  f.client.machines.pause = async (id) => {
    sleeps++;
    f.machines.get(id)!.status = "suspended";
    throw Error("lost pause ACK");
  };
  f.client.machines.resume = async (id) => {
    wakes++;
    f.machines.get(id)!.status = "running";
    throw Error("lost resume ACK");
  };
  const provider = new BoxdHostProvider(
    state,
    f.client,
    "pool",
    async () => {},
  );
  const expiresAt = Date.now() + 3599000;
  await provider.allocate({
    owner: "alice",
    operationId: "allocation",
    expiresAt,
  });
  const input = {
    host: "host",
    owner: "alice",
    allocationId: "allocation",
    expiresAt,
    mode: "ram" as const,
    operationId: "sleep",
  };
  await assert.rejects(
    provider.idlePower.sleep({ ...input, owner: "bob" }),
    /authority/,
  );
  assert.equal(sleeps, 0);
  await assert.rejects(provider.idlePower.sleep(input), /lost pause/);
  assert.equal(await provider.idlePower.sleep(input), "asleep");
  assert.equal(sleeps, 1);
  const wake = { ...input, operationId: "wake" };
  await assert.rejects(provider.idlePower.wake(wake), /lost resume/);
  assert.equal(await provider.idlePower.wake(wake), "awake");
  assert.equal(wakes, 1);
  await assert.rejects(
    provider.idlePower.sleep({ ...input, mode: "disk" }),
    /unavailable/,
  );
});

test("boxd rejects out-of-range lifetimes before RPC and fences expired control while allowing cleanup", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  const f = fixture();
  let now = 1000;
  const provider = new BoxdHostProvider(
    state,
    f.client,
    "pool",
    async () => {},
    { now: () => now },
  );
  for (const expiresAt of [now, now + 999, now + 86400001, Number.NaN]) {
    await assert.rejects(
      provider.allocate({ owner: "alice", operationId: "invalid", expiresAt }),
      /lifetime/,
    );
  }
  assert.equal(f.creates, 0);
  await provider.allocate({
    owner: "alice",
    operationId: "valid",
    expiresAt: 2000,
  });
  now = 2000;
  await assert.rejects(provider.owned("host"), /owned/);
  assert.equal((await provider.inspect("host")).state, "ready");
  await provider.retire("host", "valid");
  assert.equal((await provider.inspect("host")).state, "absent");
});

test("transient bootstrap control loss returns unknown on the same owned allocation; policy errors still reject", async (t) => {
  const { HostTransportError } = await import("../src/core/transport.js");
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  const f = fixture();
  let attempts = 0;
  const provider = new BoxdHostProvider(
    state,
    f.client,
    "pool",
    async () => {
      attempts++;
      if (attempts === 1)
        throw new HostTransportError("Lost bootstrap completion", {
          provider: "boxd",
          code: "remote-exit",
          exitCode: 1,
        });
      if (attempts === 3) throw Error("Bootstrap identity changed");
    },
    { now: () => 1000 },
  );
  const input = { owner: "alice", operationId: "existing", expiresAt: 3600000 };
  await provider.allocate(input);
  assert.deepEqual(await provider.inspect("host"), {
    state: "unknown",
    diagnostic: { provider: "boxd", code: "remote-exit", exitCode: 1 },
  });
  await provider.allocate(input);
  assert.equal((await provider.inspect("host")).state, "ready");
  assert.equal(f.creates, 1, "reconciliation observes the original host");
  await assert.rejects(provider.inspect("host"), /identity changed/);
});

test("control deadline remains uncertain even when closing the SDK stream reports exit zero", async () => {
  const { HostTransportError } = await import("../src/core/transport.js");
  const f = fixture();
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  f.client.machines.streamExec = () => {
    calls++;
    const stdout = (async function* (): AsyncGenerator<Uint8Array> {
      await closed;
    })();
    return {
      stdout,
      stderr: (async function* () {})(),
      write() {},
      end() {},
      close() {
        finish();
      },
      wait: async () => {
        await closed;
        return 0;
      },
      [Symbol.asyncIterator]() {
        return stdout[Symbol.asyncIterator]();
      },
    };
  };
  const channel = new BoxdControlChannel(f.client, async () => {});
  await assert.rejects(
    channel.run("host", ["control"], new Uint8Array(), { timeoutMs: 5 }),
    (error: unknown) =>
      error instanceof HostTransportError &&
      error.uncertain &&
      error.details?.code === "deadline",
  );
  assert.equal(calls, 1);
});
