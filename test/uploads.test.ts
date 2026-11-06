import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Json } from "../src/core/contracts.js";
import { OperationJournal } from "../src/core/operations.js";
import { UploadCoordinator } from "../src/core/uploads.js";
import { SqliteState } from "../src/state/sqlite.js";

test("upload finish survives lost ACK and shutdown settles before generation advance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jetski-uploads-"));
  const state = new SqliteState(join(root, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(root, { recursive: true, force: true });
  });
  const operations = new OperationJournal(state);
  const scope = { owner: "owner", sandbox: randomUUID() },
    id = randomUUID(),
    incomplete = randomUUID();
  const fence = await operations.generation(scope);
  const lease = {
    owner: scope.owner,
    sandboxId: scope.sandbox,
    poolId: "pool",
    slotId: randomUUID(),
    machineId: "host",
    assignmentId: randomUUID(),
    generation: 1,
  };
  const sandbox = {
    id: scope.sandbox,
    owner: scope.owner,
    lease,
    image: "image",
    phase: "running",
    pendingResume: null,
    generation: 1,
  };
  await state.transaction((tx) =>
    tx.put(`sandbox/${scope.owner}/${scope.sandbox}`, sandbox),
  );
  const spec = {
    path: "/workspace/file",
    bytes: 1,
    sha256: "a".repeat(64),
    mode: 0o640,
  };
  const receipts = new Map<string, { [key: string]: Json }>();
  let loseAck = true,
    unavailable = false,
    publications = 0,
    calls = 0,
    loseBeginAck = true;
  const request = async (
    _lease: import("../src/core/pool.js").HostLease,
    action: string,
    raw: Json,
  ): Promise<Json> => {
    calls++;
    if (unavailable) throw Error("host unavailable");
    const input = raw as { [key: string]: Json },
      uploadId = String(input.uploadId);
    let receipt = receipts.get(uploadId);
    if (action === "file-write-begin") {
      receipt ??= { ...spec, id: uploadId, offset: 0, phase: "receiving" };
      receipts.set(uploadId, receipt);
    }
    assert.ok(receipt);
    if (action === "file-write-chunk") receipt.offset = 1;
    if (action === "file-write-finish") {
      if (receipt.phase !== "committed") {
        publications++;
        receipt.phase = "committed";
      }
      if (loseAck) {
        loseAck = false;
        throw Error("lost ACK");
      }
    }
    return { ...receipt };
  };
  const uncertainBegin: typeof request = async (...args) => {
    const receipt = await request(...args);
    if (args[1] === "file-write-begin" && loseBeginAck) {
      loseBeginAck = false;
      throw Error("lost begin ACK");
    }
    return receipt;
  };
  let uploads = new UploadCoordinator(state, operations, uncertainBegin);
  await assert.rejects(uploads.begin(scope, id, spec), /lost begin ACK/);
  const initial = await state.transaction((tx) =>
    tx.get<{ initialized?: boolean }>(
      `upload/${scope.owner}/${scope.sandbox}/${id}`,
    ),
  );
  assert.equal(initial?.initialized, undefined);
  await uploads.begin(scope, id, spec);
  await assert.rejects(uploads.finish(scope, id), /incomplete/);
  const chunkCalls = calls;
  await uploads.chunk(scope, id, 0, "eA==", "b".repeat(64));
  assert.equal(
    calls,
    chunkCalls + 1,
    "known initialization removes a redundant pre-chunk begin",
  );
  await assert.rejects(uploads.finish(scope, id), /lost ACK/);
  assert.equal((await operations.get(scope, id))?.phase, "uncertain");
  await uploads.begin(scope, incomplete, spec);
  await state.transaction((tx) =>
    tx.put(`sandbox/${scope.owner}/${scope.sandbox}`, {
      ...sandbox,
      phase: "stopping",
    }),
  );
  uploads = new UploadCoordinator(state, operations, request);
  unavailable = true;
  await assert.rejects(uploads.settle(scope), /host unavailable/);
  assert.equal((await operations.get(scope, incomplete))?.phase, "failed");
  await assert.rejects(
    uploads.chunk(scope, incomplete, 0, "eA==", "b".repeat(64)),
    /cannot receive/,
  );
  unavailable = false;
  await uploads.settle(scope);
  assert.equal((await operations.get(scope, id))?.phase, "succeeded");
  assert.equal(publications, 1);
  await operations.advance(fence);
  unavailable = true;
  const previousCalls = calls;
  assert.equal((await uploads.begin(scope, id, spec)).phase, "committed");
  assert.equal((await uploads.finish(scope, id)).phase, "committed");
  assert.equal((await uploads.status(scope, id)).phase, "committed");
  assert.equal(calls, previousCalls);
  await assert.rejects(
    uploads.begin(scope, id, { ...spec, path: "/workspace/other" }),
    /identity conflict/,
  );
  await assert.rejects(
    uploads.status({ ...scope, owner: "foreign" }, id),
    /unavailable/,
  );
});

test("shutdown never quiesces an unresolved publication", async (t) => {
  const { SandboxManager } = await import("../src/core/manager.js");
  const { LocalCheckpointStore } = await import("../src/storage/local.js");
  const root = await mkdtemp(join(tmpdir(), "jetski-upload-stop-"));
  const state = new SqliteState(join(root, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(root, { recursive: true, force: true });
  });
  const image = "example/linux@sha256:" + "a".repeat(64),
    sandbox = randomUUID(),
    uploadId = randomUUID();
  const scope = { owner: "owner", sandbox },
    spec = {
      path: "/workspace/file",
      bytes: 0,
      sha256: "b".repeat(64),
      mode: 0o600,
    };
  let fail = true,
    quiesces = 0;
  const manager = new SandboxManager(
    state,
    {
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
    },
    {
      request: async (_host, request) => {
        let result: Json = null;
        if (request.action === "file-write-begin")
          result = { ...spec, id: uploadId, offset: 0, phase: "receiving" };
        if (request.action === "file-write-finish") {
          if (fail) throw Error("uncertain publication");
          result = { ...spec, id: uploadId, offset: 0, phase: "committed" };
        }
        if (request.action === "quiesce") {
          quiesces++;
          throw Error("stop after barrier");
        }
        return { version: 1, id: request.id, result };
      },
    },
    new LocalCheckpointStore(join(root, "objects")),
    { poolId: "pool", approvedImages: [image] },
  );
  await manager.create(scope.owner, sandbox, image, randomUUID());
  await manager.reconcile(scope.owner);
  await manager.uploads.begin(scope, uploadId, spec);
  await assert.rejects(manager.uploads.finish(scope, uploadId), /uncertain/);
  await manager.stop(scope, randomUUID());
  await assert.rejects(manager.reconcile(scope.owner), /uncertain/);
  assert.equal(quiesces, 0);
  assert.equal((await manager.get(scope))?.phase, "quarantined");
  assert.ok((await manager.get(scope))?.lease);
  fail = false;
  await assert.rejects(manager.reconcile(scope.owner), /stop after barrier/);
  assert.equal(quiesces, 1);
  assert.equal((await manager.operation(scope, uploadId))?.phase, "succeeded");
});
