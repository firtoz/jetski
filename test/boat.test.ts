import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HostTransport } from "../src/core/transport.js";
import {
  BoatApi,
  BoatDownloadRangeUnsupported,
  BoatHostProvider,
} from "../src/providers/boat.js";
import { SqliteState } from "../src/state/sqlite.js";

test("Boat allocation preserves request identity across loss and restart; retirement is owned and observed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-boat-"));
  let state = new SqliteState(join(directory, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  let now = 1000,
    loss = true,
    gone = false,
    acceptDelete = false,
    agentReady = false;
  const requests: Array<{
    method: string;
    url: string;
    headers: Headers;
    body: string | undefined;
  }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), "Bearer fixture");
    const method = init?.method ?? "GET";
    requests.push({
      method,
      url: String(url),
      headers,
      body: init?.body as string | undefined,
    });
    if (method === "POST" && loss) {
      loss = false;
      throw Error("lost create ACK");
    }
    if (method === "DELETE") {
      assert.equal(headers.get("X-Ascii-Confirm-Delete"), "bx_owned");
      gone = acceptDelete;
      return Response.json({ ok: true }, { status: 202 });
    }
    if (gone)
      return Response.json(
        { ok: false, error: { code: "not_found" } },
        { status: 404 },
      );
    return Response.json(
      { ok: true, sandbox: { id: "bx_owned", state: "idle" } },
      { status: method === "POST" ? 202 : 200 },
    );
  };
  const transport: HostTransport = {
    request: async (id, request) => ({
      version: 1,
      id: request.id,
      result: { machineId: id, ready: agentReady },
    }),
  };
  const api = new BoatApi("fixture", fetcher);
  let provider = new BoatHostProvider(
    state,
    api,
    transport,
    "small",
    () => now,
  );
  const input = {
    owner: "owner",
    operationId: "allocate",
    expiresAt: now + 3_600_000,
  };
  await assert.rejects(provider.allocate(input), /lost create ACK/);
  state.close();
  state = new SqliteState(join(directory, "state.sqlite"));
  now += 1000;
  provider = new BoatHostProvider(state, api, transport, "large", () => now);
  assert.deepEqual(await provider.allocate(input), {
    id: "bx_owned",
    allocationId: "allocate",
  });
  assert.equal(requests[0]!.body, requests[1]!.body);
  assert.equal(
    requests[0]!.headers.get("Idempotency-Key"),
    requests[1]!.headers.get("Idempotency-Key"),
  );
  assert.deepEqual(JSON.parse(requests[1]!.body!), {
    type: "small",
    ttlSeconds: 3600,
    noEnv: true,
    env: {},
    snapshots: false,
    monitoring: false,
  });
  await provider.allocate(input);
  assert.equal(requests.length, 2);
  await assert.rejects(
    provider.allocate({ ...input, expiresAt: input.expiresAt + 1 }),
    /identity conflict/,
  );
  assert.deepEqual(await provider.inspect("bx_owned"), { state: "unknown" });
  agentReady = true;
  assert.deepEqual(await provider.inspect("bx_owned"), { state: "ready" });
  const before = requests.length;
  await assert.rejects(provider.retire("bx_foreign", "allocate"), /not owned/);
  await assert.rejects(provider.retire("bx_owned", "stale"), /Stale/);
  assert.equal(requests.length, before);
  await assert.rejects(
    provider.retire("bx_owned", "allocate"),
    /pending or uncertain/,
  );
  acceptDelete = true;
  await provider.retire("bx_owned", "allocate");
  const retiredCalls = requests.length;
  await provider.retire("bx_owned", "allocate");
  assert.deepEqual(await provider.inspect("bx_owned"), { state: "absent" });
  assert.equal(requests.length, retiredCalls);
  assert.deepEqual(await provider.allocate(input), {
    id: "bx_owned",
    allocationId: "allocate",
  });
  assert.equal(
    requests.length,
    retiredCalls,
    "terminal allocation replay must not create another host",
  );
});

test("expired uncertain Boat allocation cannot trigger a new billable request", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  let calls = 0,
    now = 1000;
  const api = new BoatApi("fixture", async () => {
    calls++;
    throw Error("uncertain");
  });
  const provider = new BoatHostProvider(
    state,
    api,
    {
      request: async () => {
        throw Error("unused");
      },
    },
    "small",
    () => now,
  );
  const input = { owner: "owner", operationId: "operation", expiresAt: 2000 };
  await assert.rejects(provider.allocate(input), /uncertain/);
  now = 2000;
  await assert.rejects(provider.allocate(input), /Expired uncertain/);
  assert.equal(calls, 1);
  await assert.rejects(
    provider.allocate({
      ...input,
      operationId: "too-long",
      expiresAt: now + 24 * 60 * 60_000 + 1000,
    }),
    /supported bound/,
  );
  assert.equal(calls, 1);
});

test("Boat HTTP rejects oversized and non-JSON responses without echoing content", async () => {
  const oversized = new BoatApi(
    "fixture",
    async () => new Response("s".repeat(1024 * 1024 + 1)),
  );
  await assert.rejects(oversized.call("/sandboxes"), /bound exceeded/);
  const invalid = new BoatApi(
    "fixture",
    async () => new Response("private diagnostic HTML"),
  );
  await assert.rejects(invalid.call("/sandboxes"), {
    message: "Invalid Boat JSON response",
  });
  await assert.rejects(invalid.call("/wallet"), /Unsupported Boat route/);
});

test("Boat API does not bind a receiver-sensitive fetch to its adapter", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async function (this: unknown, url, init) {
    assert.equal(
      this,
      undefined,
      "native fetch must not receive the adapter as this",
    );
    assert.equal(String(url), "https://boat.dev/api/v1/sandboxes");
    assert.equal(init?.redirect, "manual");
    calls++;
    return Response.json({ sandboxes: [] });
  };
  assert.deepEqual(
    (await new BoatApi("fixture", fetcher).call("/sandboxes")).value,
    { sandboxes: [] },
  );
  assert.equal(calls, 1);
});

test("Boat redirects are refused without reading or following the destination", async () => {
  let calls = 0,
    cancelled = false;
  const fetcher: typeof fetch = async (_url, init) => {
    assert.equal(init?.redirect, "manual");
    calls++;
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      {
        status: 307,
        headers: { location: "https://other.invalid/credential-trap" },
      },
    );
  };
  await assert.rejects(
    new BoatApi("fixture", fetcher).call("/sandboxes"),
    /redirect prohibited/,
  );
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});

test("a long physical lease never extends uncertain allocation replay past key retention", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  let now = 1_000,
    calls = 0;
  const api = new BoatApi("fixture", async () => {
    calls++;
    throw Error("uncertain");
  });
  const provider = new BoatHostProvider(
    state,
    api,
    {
      request: async () => {
        throw Error("unused");
      },
    },
    "small",
    () => now,
  );
  const input = {
    owner: "owner",
    operationId: "long-lease",
    expiresAt: now + 24 * 60 * 60_000,
  };
  await assert.rejects(provider.allocate(input), /uncertain/);
  now += 23 * 60 * 60_000;
  assert.ok(now < input.expiresAt);
  await assert.rejects(provider.allocate(input), /Expired uncertain/);
  assert.equal(
    calls,
    1,
    "provider idempotency expiry cannot create another paid VM",
  );
});

test("only an ignored HTTP range is a capability fallback; server errors stay failures", async () => {
  for (const status of [200, 403, 500]) {
    const api = new BoatApi("fixture", async (url) => {
      if (String(url).endsWith("/files/download-url"))
        return Response.json({
          method: "GET",
          url: "https://downloads.example/immutable",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        });
      return new Response(new Uint8Array(8), { status });
    });
    const source = await api.openDownload("bx_fixture", "/tmp/immutable", 8);
    await assert.rejects(source.read(0, 2), (error) => {
      assert.equal(
        error instanceof BoatDownloadRangeUnsupported,
        status === 200,
      );
      return true;
    });
    await source.close();
  }
});
