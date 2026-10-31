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

const image = "example/linux@sha256:" + "a".repeat(64);
const sha = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
for (const failure of ["release-ack", "upload", "none"] as const)
  test(`shutdown publication and restart: ${failure}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "jetski-stop-"));
    const state = new SqliteState(join(directory, "state.sqlite"));
    t.after(async () => {
      state.close();
      await rm(directory, { recursive: true, force: true });
    });
    const objects = new LocalCheckpointStore(join(directory, "objects"));
    const raw = Buffer.from("fixture archive"),
      archive = gzipSync(raw);
    const manifest = {
      version: 1,
      sha256: sha(archive),
      bytes: archive.length,
      expandedBytes: raw.length,
      entries: 2,
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
    const actions: string[] = [];
    let failRelease = failure === "release-ack",
      allocations = 0;
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
        actions.push(request.action);
        let result: Json = null;
        if (request.action === "capture") result = manifest;
        if (request.action === "read-checkpoint") {
          if (failure === "upload") throw Error("interrupted upload");
          const input = request.payload as { offset: number; bytes: number };
          result = {
            ...input,
            base64: archive
              .subarray(input.offset, input.offset + input.bytes)
              .toString("base64"),
          };
        }
        if (["remove", "release", "purge-source"].includes(request.action)) {
          const listed = [];
          for await (const entry of objects.list(scope)) listed.push(entry);
          assert.equal(listed.length, 1, "publication before destruction");
          if (request.action === "release" && failRelease) {
            failRelease = false;
            throw Error("release ACK lost");
          }
        }
        return { version: 1, id: request.id, result };
      },
    };
    const options = { poolId: "pool", approvedImages: [image] },
      id = randomUUID(),
      scope = { owner: "alice", sandbox: id };
    let manager = new SandboxManager(
      state,
      provider,
      transport,
      objects,
      options,
    );
    await manager.create("alice", id, image, randomUUID());
    await manager.reconcile("alice");
    const stopId = randomUUID();
    await manager.stop(
      scope,
      stopId,
      failure === "none" ? "checkpoint" : "stop",
    );
    await assert.rejects(
      manager.startCommand(scope, randomUUID(), ["true"]),
      /not running/,
    );
    if (failure !== "none")
      await assert.rejects(
        manager.reconcile("alice"),
        failure === "upload" ? /interrupted upload/ : /release ACK lost/,
      );
    else await manager.reconcile("alice");
    manager = new SandboxManager(state, provider, transport, objects, options);
    await manager.reconcile("alice");
    if (failure === "upload") {
      assert.equal((await manager.get(scope))?.phase, "quarantined");
      assert.equal(actions.includes("remove"), false);
      assert.equal(actions.includes("release"), false);
      assert.equal(
        actions.filter((action) => action === "read-checkpoint").length,
        1,
        "failed publication is not replayed",
      );
      return;
    }
    assert.equal((await manager.operation(scope, stopId))?.phase, "succeeded");
    assert.equal((await manager.get(scope))?.phase, "stopped");
    if (failure === "none") {
      assert.ok((await manager.get(scope))?.lease, "checkpoint retains host");
      assert.equal(actions.includes("remove"), false);
      await manager.stop(scope, randomUUID());
      await manager.reconcile("alice");
    }
    assert.equal((await manager.get(scope))?.lease, null);
    assert.ok(actions.indexOf("read-checkpoint") < actions.indexOf("remove"));
    assert.ok(actions.indexOf("release") < actions.indexOf("purge-source"));
    const count = actions.length;
    await manager.stop(
      scope,
      stopId,
      failure === "none" ? "checkpoint" : "stop",
    );
    await manager.reconcile("alice");
    assert.equal(
      actions.length,
      count,
      "completed stop replay has no host effects",
    );
    await manager.create("alice", randomUUID(), image, randomUUID());
    await manager.reconcile("alice");
    assert.equal(allocations, 1, "next assignment reuses warm host");
  });
