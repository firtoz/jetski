import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { CheckpointRegistry } from "../src/core/checkpoints.js";
import type { HostProvider, Json } from "../src/core/contracts.js";
import { SandboxManager } from "../src/core/manager.js";
import { CheckpointTransfer } from "../src/core/transfer.js";
import type { HostTransport } from "../src/core/transport.js";
import { JetskiClient } from "../src/sdk.js";
import { bearerAuthentication, createHttpServer } from "../src/server/http.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

for (const stage of ["remove", "release", "purge-source", "read-checkpoint"])
  for (const observation of ["absent", "unknown", "ready", "corrupt"] as const)
    test(`host loss at ${stage}, provider ${observation}`, async (t) => {
      const dir = await mkdtemp(join(tmpdir(), "jetski-missing-stop-"));
      let state = new SqliteState(join(dir, "state.sqlite"));
      t.after(async () => {
        state.close();
        await rm(dir, { recursive: true, force: true });
      });
      const objects = new LocalCheckpointStore(join(dir, "objects"));
      const raw = Buffer.from("retained filesystem bytes"),
        archive = gzipSync(raw);
      const sha = (bytes: Uint8Array) =>
        createHash("sha256").update(bytes).digest("hex");
      const manifest = {
        version: 1,
        bytes: archive.length,
        expandedBytes: raw.length,
        entries: 2,
        sha256: sha(archive),
        frames: [
          {
            offset: 0,
            bytes: archive.length,
            expandedBytes: raw.length,
            sha256: sha(archive),
            expandedSha256: sha(raw),
          },
        ],
      };
      let lost = false,
        unavailableEffects = 0,
        allocations = 0;
      const imported: Buffer[] = [];
      let importReceipt:
        | {
            id: string;
            sha256: string;
            bytes: number;
            offset: number;
            phase: string;
          }
        | undefined;
      const head = objects.head.bind(objects);
      objects.head = async (ref) => {
        if (lost && observation === "corrupt") return undefined;
        return head(ref);
      };
      const providerState = observation === "corrupt" ? "absent" : observation;
      const provider: HostProvider = {
        capabilities: () => ({
          kind: "machine-host",
          architecture: "x86_64",
          rootlessPodman: true,
        }),
        allocate: async (input) => ({
          id: ++allocations === 1 ? "host" : "replacement",
          allocationId: input.operationId,
        }),
        inspect: async (id) => ({
          state: id === "host" && lost ? providerState : "ready",
        }),
        retire: async () => {},
      };
      const transport: HostTransport = {
        request: async (_id, request) => {
          if (_id === "host" && lost) {
            unavailableEffects++;
            throw Error("host unavailable");
          }
          if (_id === "host" && request.action === stage) {
            lost = true;
            throw Error("host disappeared");
          }
          let result: Json = null;
          if (request.action === "import-begin") {
            const input = request.payload as {
              checkpointId: string;
              sha256: string;
              bytes: number;
            };
            importReceipt = {
              id: input.checkpointId,
              sha256: input.sha256,
              bytes: input.bytes,
              offset: 0,
              phase: "receiving",
            };
            result = { ...importReceipt };
          }
          if (request.action === "import-chunk") {
            const part = Buffer.from(
              (request.payload as { base64: string }).base64,
              "base64",
            );
            imported.push(part);
            importReceipt!.offset += part.length;
            result = { ...importReceipt! };
          }
          if (request.action === "import-finish") {
            importReceipt!.phase = "ready";
            result = { ...importReceipt! };
          }

          if (request.action === "capture") result = manifest;
          if (request.action === "read-checkpoint") {
            const input = request.payload as { offset: number; bytes: number };
            result = {
              ...input,
              base64: archive
                .subarray(input.offset, input.offset + input.bytes)
                .toString("base64"),
            };
          }
          return { version: 1, id: request.id, result };
        },
      };
      const image = "example/linux@sha256:" + "a".repeat(64);
      const options = { poolId: "pool", approvedImages: [image] };
      let manager = new SandboxManager(
        state,
        provider,
        transport,
        objects,
        options,
      );
      const scope = { owner: "alice", sandbox: randomUUID() },
        stop = randomUUID();
      await manager.create(scope.owner, scope.sandbox, image, randomUUID());
      await manager.reconcile(scope.owner);
      const retained = randomUUID();
      if (stage === "read-checkpoint")
        await new CheckpointTransfer(
          objects,
          new CheckpointRegistry(state, objects),
        ).save({ ...scope, generation: 1 }, retained, manifest, {
          read: async (offset, bytes) =>
            archive.subarray(offset, offset + bytes),
        });
      await manager.stop(scope, stop);
      const recoverable =
        observation === "absent" && stage !== "read-checkpoint";
      if (recoverable) await manager.reconcile(scope.owner);
      else
        await assert.rejects(
          manager.reconcile(scope.owner),
          /host disappeared/,
        );
      state.close();
      state = new SqliteState(join(dir, "state.sqlite"));
      manager = new SandboxManager(
        state,
        provider,
        transport,
        objects,
        options,
      );
      if (recoverable) {
        await manager.reconcile(scope.owner);
        const sandbox = await manager.get(scope);
        assert.equal(sandbox?.phase, "stopped");
        assert.equal(sandbox?.lease, null);
        assert.equal(sandbox?.checkpoint, stop);
        assert.equal(
          (await manager.operation(scope, stop))?.phase,
          "succeeded",
        );
        assert.equal(
          (await manager.history.get(scope, stop))?.sha256,
          sha(archive),
        );
        assert.equal(
          unavailableEffects,
          0,
          "no further workload effects on absent host",
        );
        await manager.resume(scope, randomUUID());
        await manager.reconcile(scope.owner);
        assert.equal((await manager.get(scope))?.phase, "running");
        assert.equal(
          (await manager.get(scope))?.lease?.machineId,
          "replacement",
        );
        assert.equal((await manager.get(scope))?.generation, 2);
        assert.deepEqual(Buffer.concat(imported), archive);
        assert.equal(allocations, 2);
        assert.equal(unavailableEffects, 0);
      } else {
        assert.equal((await manager.get(scope))?.phase, "quarantined");
        assert.ok((await manager.get(scope))?.lease);
        assert.equal(
          (await manager.operation(scope, stop))?.phase,
          "uncertain",
        );
        if (stage === "read-checkpoint")
          assert.equal(await manager.history.get(scope, stop), undefined);
        if (stage === "read-checkpoint") {
          const sandbox = (await manager.get(scope))!;
          const recoveryId = randomUUID();
          const input = {
            generation: sandbox.generation,
            lease: sandbox.lease!,
            shutdownId: stop,
            checkpointId: retained,
            acknowledgement: "unpublished-changes-unavailable" as const,
          };
          if (observation !== "absent") {
            await assert.rejects(
              manager.recoverMissingSource(scope, recoveryId, input),
              /absence|integrity/,
            );
            assert.equal((await manager.get(scope))?.phase, "quarantined");
            assert.equal(allocations, 1);
            return;
          }
          await assert.rejects(
            manager.recoverMissingSource(scope, recoveryId, {
              ...input,
              generation: 2,
            }),
            /authority/,
          );
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
          const client = new JetskiClient(url, "a".repeat(32));
          await assert.rejects(
            client.recoverMissingSource(scope.sandbox, recoveryId, {
              ...input,
              lease: { ...input.lease, assignmentId: randomUUID() },
            }),
          );
          const registry = new CheckpointRegistry(state, objects);
          const fence = { ...scope, generation: input.generation };
          await registry.admit(fence, "concurrent-reader", "reader", retained);
          await assert.rejects(
            client.recoverMissingSource(scope.sandbox, recoveryId, input),
          );
          assert.equal(await manager.operation(scope, recoveryId), undefined);
          assert.equal((await manager.get(scope))?.phase, "quarantined");
          await registry.close(fence, "concurrent-reader");
          await assert.rejects(
            new JetskiClient(url, "b".repeat(32)).recoverMissingSource(
              scope.sandbox,
              recoveryId,
              input,
            ),
          );
          const result = await client.recoverMissingSource(
            scope.sandbox,
            recoveryId,
            input,
          );
          assert.equal(result.phase, "succeeded");
          assert.equal(
            (await manager.operation(scope, stop))?.phase,
            "uncertain",
          );
          assert.equal((await manager.get(scope))?.generation, 2);
          assert.equal((await manager.get(scope))?.phase, "stopped");
          assert.equal((await manager.get(scope))?.lease, null);
          assert.equal(await manager.history.get(scope, stop), undefined);
          state.close();
          state = new SqliteState(join(dir, "state.sqlite"));
          manager = new SandboxManager(
            state,
            provider,
            transport,
            objects,
            options,
          );
          assert.deepEqual(
            await manager.recoverMissingSource(scope, recoveryId, input),
            result,
          );
          await assert.rejects(
            manager.recoverMissingSource(scope, recoveryId, {
              ...input,
              checkpointId: stop,
            }),
            /identity/,
          );
          await manager.resume(scope, randomUUID());
          await manager.reconcile(scope.owner);
          assert.equal((await manager.get(scope))?.phase, "running");
          assert.equal((await manager.get(scope))?.generation, 3);
          assert.deepEqual(Buffer.concat(imported), archive);
          assert.equal(allocations, 2);
          assert.equal(unavailableEffects, 0);
        }
      }
    });
