import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { checkpointArchive } from "../src/core/checkpoint-layout.js";
import { CheckpointRegistry } from "../src/core/checkpoints.js";
import type {
  CheckpointStore,
  HostProvider,
  Json,
} from "../src/core/contracts.js";
import { SandboxManager } from "../src/core/manager.js";
import type { HostTransport } from "../src/core/transport.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const image = "example/linux@sha256:" + "a".repeat(64);
for (const failure of [
  "none",
  "seal-ack",
  "upload",
  "unsupported",
  "resume-ack",
  "resume-uncertain",
  "memory-unavailable",
  "source-absent",
] as const)
  test(`memory suspension publication and replay: ${failure}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "jetski-memory-"));
    const state = new SqliteState(join(directory, "state.sqlite"));
    t.after(async () => {
      state.close();
      await rm(directory, { recursive: true, force: true });
    });
    const local = new LocalCheckpointStore(join(directory, "objects"));
    let failUpload = failure === "upload",
      loseSeal = failure === "seal-ack";
    const objects: CheckpointStore = new Proxy(local, {
      get(target, key) {
        if (key === "put")
          return async (...args: Parameters<CheckpointStore["put"]>) => {
            if (failUpload) throw Error("Injected store failure");
            return target.put(...args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const owner = "owner",
      sandbox = randomUUID(),
      scope = { owner, sandbox };
    const raw = Buffer.from("frozen fixture"),
      archive = gzipSync(raw);
    const manifest = {
      version: 1,
      sha256: hash(archive),
      bytes: archive.length,
      expandedBytes: raw.length,
      entries: 2,
      frames: [
        {
          offset: 0,
          bytes: archive.length,
          expandedBytes: raw.length,
          sha256: hash(archive),
          expandedSha256: hash(raw),
        },
      ],
    };
    const actions: string[] = [];
    let commandStarts = 0;
    let frozen = false,
      sealed = false,
      freezeEffects = 0,
      sealEffects = 0,
      resumeEffects = 0,
      resumedLease: Json = null,
      loseResume = failure === "resume-ack";
    let sourceAbsent = false;
    const importReceipt = {
      id: "",
      sha256: manifest.sha256,
      bytes: archive.length,
      offset: 0,
      phase: "receiving",
    };
    const provider: HostProvider = {
      capabilities: () => ({
        kind: "machine-host",
        architecture: "x86_64",
        rootlessPodman: true,
      }),
      allocate: async (input) => ({
        id: sourceAbsent ? "replacement" : "machine",
        allocationId: input.operationId,
      }),
      inspect: async (id) => ({
        state: sourceAbsent && id === "machine" ? "absent" : "ready",
      }),
      retire: async () => {
        throw Error("Unexpected retirement");
      },
    };
    const registry = new CheckpointRegistry(state, objects);
    const transport: HostTransport = {
      request: async (_host, request) => {
        actions.push(request.action);
        const payload = request.payload as Record<string, Json>;
        let result: Json = {};
        switch (request.action) {
          case "status":
            result =
              failure === "unsupported" ? {} : { memorySuspendVersion: 1 };
            break;
          case "claim":
          case "create":
            break;
          case "command-start":
            commandStarts++;
            result = {
              id: payload.commandId!,
              phase: "succeeded",
              exitCode: 0,
            };
            break;
          case "command-status":
            result = {
              id: payload.commandId!,
              phase: "succeeded",
              exitCode: 0,
            };
            break;
          case "command-output": {
            const full =
              payload.channel === "stdout"
                ? Buffer.from([0, 255])
                : Buffer.alloc(0);
            const part = full.subarray(
              Number(payload.offset),
              Number(payload.offset) + Number(payload.bytes),
            );
            result = {
              base64: part.toString("base64"),
              nextOffset: Number(payload.offset) + part.length,
              terminal: true,
            };
            break;
          }
          case "memory-freeze":
            if (!frozen) {
              frozen = true;
              freezeEffects++;
            }
            result = { phase: "frozen", checkpointReadBytes: 1280 * 1024 };
            break;
          case "capture":
            assert.ok(frozen);
            result = manifest;
            break;
          case "read-checkpoint": {
            const offset = Number(payload.offset),
              bytes = Number(payload.bytes),
              part = archive.subarray(offset, offset + bytes);
            result = {
              offset,
              bytes,
              sha256: hash(part),
              base64: part.toString("base64"),
            };
            break;
          }
          case "memory-discard":
            result = {
              phase: "discarded",
              checkpointId: payload.checkpointId!,
              lease: payload.nextLease!,
            };
            break;
          case "release":
          case "purge-source":
            break;
          case "import-begin":
            importReceipt.id = String(payload.checkpointId);
            result = { ...importReceipt };
            break;
          case "import-chunk": {
            assert.equal(payload.offset, importReceipt.offset);
            const bytes = Buffer.from(String(payload.base64), "base64");
            assert.deepEqual(
              bytes,
              archive.subarray(
                importReceipt.offset,
                importReceipt.offset + bytes.length,
              ),
            );
            importReceipt.offset += bytes.length;
            result = { ...importReceipt };
            break;
          }
          case "import-finish":
            assert.equal(importReceipt.offset, archive.length);
            importReceipt.phase = "ready";
            result = { ...importReceipt };
            break;
          case "memory-resume":
            if (failure === "resume-uncertain")
              throw Error("Unknown native effect");
            if (failure === "memory-unavailable")
              throw Error("Memory unavailable before effect");
            if (!resumedLease) {
              resumedLease = payload.nextLease!;
              resumeEffects++;
            }
            if (loseResume) {
              loseResume = false;
              throw Error("Lost resume acknowledgement");
            }
            result = {
              phase: "resumed",
              checkpointId: payload.checkpointId!,
              filesystemSha256: manifest.sha256,
              sha256: "b".repeat(64),
              memoryPreserved: true,
              lease: resumedLease,
            };
            break;
          case "memory-status":
            result = resumedLease
              ? {
                  phase: "resumed",
                  checkpointId: payload.checkpointId!,
                  filesystemSha256: manifest.sha256,
                  sha256: "b".repeat(64),
                  memoryPreserved: true,
                  lease: resumedLease,
                }
              : {
                  phase:
                    failure === "memory-unavailable" ? "sealed" : "resuming",
                  canDiscard: failure === "memory-unavailable",
                };
            break;
          case "memory-seal": {
            assert.ok(frozen);
            const publication = payload.publication as {
              checkpointId: string;
              sha256: string;
            };
            const root = await registry.root(
              { ...scope, generation: 1 },
              publication.checkpointId,
            );
            assert.ok(root, "seal cannot precede retained durable publication");
            assert.equal(checkpointArchive(root).sha256, manifest.sha256);
            if (!sealed) {
              sealed = true;
              sealEffects++;
            }
            if (loseSeal) {
              loseSeal = false;
              throw Error("Injected seal acknowledgement loss");
            }
            result = {
              phase: "sealed",
              checkpointId: publication.checkpointId,
              filesystemSha256: manifest.sha256,
              sha256: "b".repeat(64),
              memoryBytes: 4096,
            };
            break;
          }
          default:
            throw Error("Unexpected effect " + request.action);
        }
        return { version: 1, id: request.id, result };
      },
    };
    const options = { poolId: "pool", approvedImages: [image] };
    let manager = new SandboxManager(
      state,
      provider,
      transport,
      objects,
      options,
    );
    await manager.create(owner, sandbox, image, randomUUID());
    await manager.reconcile(owner);
    assert.equal((await manager.get(scope))?.phase, "running");
    const originalCommand = randomUUID();
    await manager.startCommand(scope, originalCommand, ["printf", "fixture"]);
    const id = randomUUID();
    if (failure === "unsupported") {
      await assert.rejects(manager.suspend(scope, id), /not supported/);
      assert.equal((await manager.get(scope))?.phase, "running");
      assert.equal(freezeEffects, 0);
      return;
    }
    await manager.suspend(scope, id);
    if (failure === "seal-ack" || failure === "upload") {
      await assert.rejects(manager.reconcile(owner));
      assert.equal((await manager.get(scope))?.phase, "quarantined");
      assert.ok(frozen);
      if (failure === "upload") assert.equal(sealEffects, 0);
      failUpload = false;
      manager = new SandboxManager(
        state,
        provider,
        transport,
        objects,
        options,
      );
    }
    await manager.reconcile(owner);
    const stopped = await manager.get(scope);
    assert.equal(stopped?.phase, "stopped");
    assert.ok(
      stopped.lease,
      "memory suspension must retain its exclusive source",
    );
    assert.equal(stopped.memory?.checkpointId, id);
    assert.equal(stopped.memory?.filesystemSha256, manifest.sha256);
    assert.equal((await manager.operation(scope, id))?.phase, "succeeded");
    assert.equal(freezeEffects, 1);
    assert.equal(sealEffects, 1);
    assert.ok(
      !actions.includes("remove") &&
        !actions.includes("release") &&
        !actions.includes("purge-source"),
    );
    const before = actions.length;
    await manager.suspend(scope, id);
    await manager.reconcile(owner);
    assert.equal(
      actions.length,
      before,
      "terminal replay must observe the original outcome",
    );
    const resumeId = randomUUID();
    sourceAbsent = failure === "source-absent";
    await manager.resumeMemory(scope, resumeId);
    manager = new SandboxManager(state, provider, transport, objects, options);
    if (failure === "resume-uncertain") {
      await assert.rejects(manager.reconcile(owner), /Unknown native effect/);
      assert.equal((await manager.get(scope))?.phase, "quarantined");
      assert.equal(
        (await manager.operation(scope, resumeId))?.phase,
        "uncertain",
      );
      assert.ok(
        !actions.includes("release") && !actions.includes("purge-source"),
      );
      return;
    }
    await manager.reconcile(owner);
    const running = await manager.get(scope);
    assert.equal(running?.phase, "running");
    assert.equal(running.generation, stopped.generation + 1);
    const originalOutput = await manager.commandOutput(
      scope,
      originalCommand,
      "stdout",
      0,
      256,
    );
    assert.equal((originalOutput as Record<string, Json>).base64, "AP8=");
    await manager.startCommand(scope, originalCommand, ["printf", "fixture"]);
    assert.equal(
      commandStarts,
      1,
      "original command replay must not execute again",
    );

    if (failure === "memory-unavailable" || failure === "source-absent") {
      await manager.reconcile(owner);
      const outcome = await manager.operation(scope, resumeId);
      assert.equal(outcome?.phase, "succeeded");
      assert.equal(
        (outcome.result as Record<string, Json>).memoryPreserved,
        false,
      );
      assert.equal(resumeEffects, 0);
      assert.equal(importReceipt.offset, archive.length);
      assert.notEqual(running.lease?.assignmentId, stopped.lease.assignmentId);
      if (failure === "source-absent")
        assert.equal(running.lease?.machineId, "replacement");
      return;
    }
    assert.equal(running.lease?.generation, stopped.lease.generation + 1);
    assert.equal(running.lease?.assignmentId, stopped.lease.assignmentId);
    assert.equal(resumeEffects, 1);
    assert.equal(
      (await manager.operation(scope, resumeId))?.phase,
      "succeeded",
    );
    const completedActions = actions.length;
    await manager.resumeMemory(scope, resumeId);
    await manager.reconcile(owner);
    assert.equal(actions.length, completedActions);
  });
