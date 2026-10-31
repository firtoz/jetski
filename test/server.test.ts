import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type HostProvider } from "../src/core/contracts.js";
import { SandboxManager } from "../src/core/manager.js";
import { type HostTransport } from "../src/core/transport.js";
import {
  bearerAuthentication,
  createHttpServer,
  startWorker,
} from "../src/server/http.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

const image = "example/linux@sha256:" + "a".repeat(64);

test("server enforces owner scope and progresses without browser polling", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-api-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  let allocations = 0,
    creations = 0;
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
    request: async (_host, request) => {
      if (request.action === "create") creations++;
      return { version: 1, id: request.id, result: { phase: "running" } };
    },
  };
  const manager = new SandboxManager(
    state,
    provider,
    transport,
    new LocalCheckpointStore(join(directory, "objects")),
    { poolId: "pool", approvedImages: [image] },
  );
  const server = createHttpServer(
    manager,
    bearerAuthentication([
      { owner: "alice", token: "a".repeat(32) },
      { owner: "bob", token: "b".repeat(32) },
    ]),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const stopWorker = startWorker(manager, () => {}, 5);
  t.after(async () => {
    await stopWorker();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal((await fetch(`${base}/v1/sandboxes`)).status, 401);
  const id = randomUUID(),
    operationId = randomUUID();
  const headers = {
    authorization: "Bearer " + "a".repeat(32),
    "content-type": "application/json",
  };
  const request = { id, operationId, image };
  assert.equal(
    (
      await fetch(`${base}/v1/sandboxes`, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
      })
    ).status,
    202,
  );
  // No GET/refresh is involved in progressing the queued creation.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(creations, 1);
  const observed = await fetch(`${base}/v1/sandboxes/${id}`, { headers });
  assert.equal(((await observed.json()) as { phase: string }).phase, "running");
  assert.equal(
    (
      await fetch(`${base}/v1/sandboxes/${id}`, {
        headers: { authorization: "Bearer " + "b".repeat(32) },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await fetch(`${base}/v1/sandboxes`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...request, owner: "bob" }),
      })
    ).status,
    400,
  );
  await fetch(`${base}/v1/sandboxes`, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(creations, 1);
  const second = randomUUID();
  await fetch(`${base}/v1/sandboxes`, {
    method: "POST",
    headers,
    body: JSON.stringify({ id: second, operationId: randomUUID(), image }),
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(allocations, 1);
  assert.equal(
    (await manager.get({ owner: "alice", sandbox: second }))?.phase,
    "queued",
  );
  const result = await fetch(
    `${base}/v1/sandboxes/${id}/operations/${operationId}`,
    { headers },
  );
  assert.equal(((await result.json()) as { phase: string }).phase, "succeeded");
});

test("uncertain create retains assignment and does not allocate or execute twice", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-manager-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  let allocations = 0,
    creations = 0;
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
    request: async (_host, request) => {
      if (request.action === "create") {
        creations++;
        throw Error("lost ACK");
      }
      if (
        request.action === "inspect" &&
        creations &&
        request.payload &&
        typeof request.payload === "object" &&
        !Array.isArray(request.payload)
      )
        return {
          version: 1,
          id: request.id,
          result: {
            phase: "open",
            lease: request.payload.lease ?? null,
            runtime: { phase: "running", image },
          },
        };
      return { version: 1, id: request.id, result: null };
    },
  };
  const objects = new LocalCheckpointStore(join(directory, "objects"));
  const options = { poolId: "pool", approvedImages: [image] };
  const manager = new SandboxManager(
    state,
    provider,
    transport,
    objects,
    options,
  );
  const id = randomUUID();
  await manager.create("alice", id, image, randomUUID());
  await assert.rejects(manager.reconcile("alice"), /lost ACK/);
  assert.equal(
    (await manager.get({ owner: "alice", sandbox: id }))?.phase,
    "quarantined",
  );
  await new SandboxManager(
    state,
    provider,
    transport,
    objects,
    options,
  ).reconcile("alice");
  assert.equal(allocations, 1);
  assert.equal(creations, 1);
  assert.equal(
    (await manager.get({ owner: "alice", sandbox: id }))?.phase,
    "running",
  );
});
