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
  await assert.rejects(
    transport.request("host", request),
    /completion unknown/,
  );
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
