import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { CheckpointRegistry } from "../src/core/checkpoints.js";
import type { HostProvider, Json } from "../src/core/contracts.js";
import { type Sandbox, SandboxManager } from "../src/core/manager.js";
import { missingPlacementRecovery } from "../src/core/placement-recovery.js";
import type { HostTransport } from "../src/core/transport.js";
import { JetskiClient } from "../src/sdk.js";
import { bearerAuthentication, createHttpServer } from "../src/server/http.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

for (const mode of [
  "absent",
  "unknown",
  "ready",
  "corrupt",
  "reader",
  "wrong-placement",
  "wrong-lease",
  "missing-reference",
  "writer",
  "stale",
  "foreign",
  "changed-during-inspect",
] as const)
  test(`interrupted placement recovery: ${mode}`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "jetski-placement-"));
    let state = new SqliteState(join(dir, "state.sqlite"));
    t.after(async () => {
      state.close();
      await rm(dir, { recursive: true, force: true });
    });
    const objects = new LocalCheckpointStore(join(dir, "objects"));
    const bytes = gzipSync(Buffer.from("retained bytes\0Unicode résumé"));
    const sha = (value: Uint8Array) =>
      createHash("sha256").update(value).digest("hex");
    const raw = Buffer.from("retained bytes\0Unicode résumé");
    const manifest = {
      version: 1,
      bytes: bytes.length,
      expandedBytes: raw.length,
      entries: 2,
      sha256: sha(bytes),
      frames: [
        {
          offset: 0,
          bytes: bytes.length,
          expandedBytes: raw.length,
          sha256: sha(bytes),
          expandedSha256: sha(raw),
        },
      ],
    };
    let failed = false,
      failCreate = false,
      allocations = 0,
      requests = 0;
    let received = Buffer.alloc(0);
    let receipt: Record<string, Json> = {};
    const scope = { owner: "alice", sandbox: randomUUID() };
    const provider: HostProvider = {
      capabilities: () => ({
        kind: "machine-host",
        architecture: "x86_64",
        rootlessPodman: true,
      }),
      allocate: async (input) => ({
        id: `host-${++allocations}`,
        allocationId: input.operationId,
      }),
      inspect: async () => {
        if (failed && mode === "changed-during-inspect")
          await state.transaction((tx) => {
            const key = `sandbox/${scope.owner}/${scope.sandbox}`;
            const sandbox = tx.get<Sandbox>(key)!;
            tx.put(key, { ...sandbox, generation: sandbox.generation + 1 });
          });
        return {
          state: failed
            ? mode === "unknown" || mode === "ready"
              ? mode
              : "absent"
            : "ready",
        };
      },
      retire: async () => {},
    };
    const transport: HostTransport = {
      request: async (_host, request) => {
        requests++;
        if (failed) throw Error("host unavailable");
        const payload = request.payload as Record<string, Json>;
        let result: Json = null;
        if (request.action === "create" && failCreate) {
          failed = true;
          throw Error("create acknowledgement lost");
        }
        if (request.action === "capture") result = manifest;
        if (request.action === "read-checkpoint")
          result = {
            ...payload,
            base64: bytes
              .subarray(
                Number(payload.offset),
                Number(payload.offset) + Number(payload.bytes),
              )
              .toString("base64"),
          };
        if (request.action === "import-begin") {
          received = Buffer.alloc(0);
          receipt = {
            id: payload.checkpointId!,
            sha256: payload.sha256!,
            bytes: payload.bytes!,
            offset: 0,
            phase: "receiving",
          };
          result = { ...receipt };
        }
        if (request.action === "import-chunk") {
          received = Buffer.concat([
            received,
            Buffer.from(String(payload.base64), "base64"),
          ]);
          receipt.offset = received.length;
          result = { ...receipt };
        }
        if (request.action === "import-finish") {
          receipt.phase = "ready";
          result = { ...receipt };
        }
        return { version: 1, id: request.id, result };
      },
    };
    const image = `example/linux@sha256:${"a".repeat(64)}`;
    const restoreManager = () =>
      new SandboxManager(state, provider, transport, objects, {
        poolId: "pool",
        approvedImages: [image],
      });
    let manager = restoreManager();
    await manager.create(scope.owner, scope.sandbox, image, randomUUID());
    await manager.reconcile(scope.owner);
    const checkpointId = randomUUID();
    await manager.stop(scope, checkpointId);
    await manager.reconcile(scope.owner);
    assert.equal((await manager.get(scope))?.phase, "stopped");
    const placementId = randomUUID();
    await manager.resume(scope, placementId);
    failCreate = true;
    await assert.rejects(
      manager.reconcile(scope.owner),
      /acknowledgement lost/,
    );
    const sandbox = (await manager.get(scope))!;
    assert.equal(sandbox.phase, "quarantined");
    const input = {
      generation: sandbox.generation,
      lease: sandbox.lease!,
      placementId,
      checkpointId,
      acknowledgement: "unpublished-changes-unavailable" as const,
    };
    const recoveryId = randomUUID(),
      beforeRequests = requests;
    state.close();
    state = new SqliteState(join(dir, "state.sqlite"));
    manager = restoreManager();
    if (mode === "corrupt") objects.head = async () => undefined;
    const registry = new CheckpointRegistry(state, objects);
    if (mode === "reader")
      await registry.admit(
        { ...scope, generation: input.generation },
        "reader",
        "reader",
        checkpointId,
      );
    if (mode === "writer")
      await registry.admit(
        { ...scope, generation: input.generation },
        "writer",
        "writer",
      );
    if (mode === "missing-reference")
      await state.transaction((tx) =>
        registry.releaseIn(
          tx,
          { ...scope, generation: input.generation },
          placementId,
        ),
      );
    const supplied = { ...input };
    if (mode === "wrong-lease")
      supplied.lease = { ...input.lease, assignmentId: randomUUID() };
    if (mode === "wrong-placement") supplied.placementId = randomUUID();
    if (mode === "stale") supplied.generation--;
    const owner = mode === "foreign" ? { ...scope, owner: "bob" } : scope;
    if (mode !== "absent") {
      await assert.rejects(
        manager.recoverMissingPlacement(owner, recoveryId, supplied),
      );
      assert.equal((await manager.get(scope))?.phase, "quarantined");
      assert.equal(await manager.operation(owner, recoveryId), undefined);
      assert.equal(allocations, 1);
      assert.equal(requests, beforeRequests);
      return;
    }
    const server = createHttpServer(
      manager,
      bearerAuthentication([
        { owner: scope.owner, token: "a".repeat(32) },
        { owner: "bob", token: "b".repeat(32) },
      ]),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    await assert.rejects(
      new JetskiClient(url, "b".repeat(32)).recoverMissingPlacement(
        scope.sandbox,
        recoveryId,
        input,
      ),
    );
    const recovered = await new JetskiClient(
      url,
      "a".repeat(32),
    ).recoverMissingPlacement(scope.sandbox, recoveryId, input);
    assert.equal(recovered.phase, "succeeded");
    assert.equal(requests, beforeRequests);
    const stopped = (await manager.get(scope))!;
    assert.equal(stopped.phase, "stopped");
    assert.equal(stopped.lease, null);
    assert.equal(stopped.generation, input.generation + 1);
    assert.equal(stopped.checkpoint, checkpointId);
    assert.equal(
      (await manager.operation(scope, placementId))?.phase,
      "uncertain",
    );
    assert.equal(
      await state.transaction((tx) =>
        tx.get(
          `checkpoint-reference/${scope.owner}/${scope.sandbox}/${placementId}`,
        ),
      ),
      undefined,
    );
    state.close();
    state = new SqliteState(join(dir, "state.sqlite"));
    manager = restoreManager();
    assert.deepEqual(
      await manager.recoverMissingPlacement(scope, recoveryId, input),
      recovered,
    );
    await assert.rejects(
      manager.recoverMissingPlacement(scope, recoveryId, {
        ...input,
        placementId: randomUUID(),
      }),
      /identity conflict/,
    );
    await manager.resume(scope, placementId); // Old identity observes its old outcome.
    assert.equal((await manager.get(scope))?.phase, "stopped");
    failed = false;
    failCreate = false;
    await manager.resume(scope, randomUUID());
    await manager.reconcile(scope.owner);
    assert.equal((await manager.get(scope))?.phase, "running");
    assert.equal(allocations, 2);
    assert.deepEqual(received, bytes);
  });

test("placement recovery parser refuses mixed or missing authority", () => {
  assert.throws(() =>
    missingPlacementRecovery({ placementId: "p", shutdownId: "s" }),
  );
  assert.throws(() => missingPlacementRecovery({ placementId: "p" }));
});
