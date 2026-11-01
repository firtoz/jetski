import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import type { HostProvider, Json } from "../src/core/contracts.js";
import { SandboxManager } from "../src/core/manager.js";
import type { HostTransport } from "../src/core/transport.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

for (const stage of ["remove", "release", "purge-source", "read-checkpoint"])
  for (const observation of ["absent", "unknown", "corrupt"] as const)
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
      const providerState = observation === "unknown" ? "unknown" : "absent";
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
      }
    });
