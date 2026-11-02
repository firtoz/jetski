import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { CheckpointRegistry } from "../src/core/checkpoints.js";
import {
  DEFAULTS,
  type HostProvider,
  type Json,
} from "../src/core/contracts.js";
import { SandboxManager } from "../src/core/manager.js";
import type { HostTransport } from "../src/core/transport.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

const image = "example/linux@sha256:" + "a".repeat(64);
const sha = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
for (const failure of [
  "release-ack",
  "finalize-ack",
  "upload",
  "none",
  "missing-idle",
  "packed",
] as const)
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
    let quiesced = false;
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
    let now = 1,
      retirements = 0;
    let failRetirement = true;
    let oldHostState: "ready" | "unknown" | "absent" = "ready";
    let failUpload = failure === "upload";
    let failRelease = failure === "release-ack" || failure === "finalize-ack",
      allocations = 0;
    const provider: HostProvider = {
      capabilities: () => ({
        kind: "machine-host",
        architecture: "x86_64",
        rootlessPodman: true,
      }),
      allocate: async (input) => {
        allocations++;
        return {
          id:
            failure === "missing-idle" && allocations > 1
              ? "replacement"
              : "host",
          allocationId: input.operationId,
        };
      },
      inspect: async (id) => ({
        state: id === "host" ? oldHostState : "ready",
      }),
      retire: async () => {
        retirements++;
        if (failRetirement) {
          failRetirement = false;
          throw Error("retirement ACK lost");
        }
      },
    };
    const transport: HostTransport = {
      request: async (_host, request) => {
        if (_host === "host" && oldHostState !== "ready")
          throw Error("Unavailable host received workload effects");
        actions.push(request.action);
        let result: Json = null;
        if (request.action === "quiesce") {
          quiesced = true;
          if (failure === "finalize-ack") result = { finalizeVersion: 1 };
        }
        if (request.action === "stream-status")
          result = {
            id: request.id,
            port: 8080,
            phase: quiesced ? "cancelled" : "uncertain",
            delivery: "unknown",
          };
        if (request.action === "capture") result = manifest;
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
          result = importReceipt;
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
        if (request.action === "read-checkpoint") {
          if (failUpload) throw Error("interrupted upload");
          const input = request.payload as { offset: number; bytes: number };
          result = {
            ...input,
            base64: archive
              .subarray(input.offset, input.offset + input.bytes)
              .toString("base64"),
          };
        }
        if (
          ["remove", "release", "purge-source", "finalize"].includes(
            request.action,
          )
        ) {
          const listed = [];
          for await (const entry of objects.list(scope)) listed.push(entry);
          assert.equal(listed.length, 1, "publication before destruction");
          if (["release", "finalize"].includes(request.action) && failRelease) {
            failRelease = false;
            throw Error("release ACK lost");
          }
        }
        if (request.action === "finalize") {
          result = {
            finalized: true,
            checkpointId: (
              request.payload as { publication: { checkpointId: string } }
            ).publication.checkpointId,
          };
        }
        return { version: 1, id: request.id, result };
      },
    };
    const options = {
        poolId: "pool",
        checkpointPackBytes: failure === "packed" ? DEFAULTS.maxObjectBytes : 0,
        approvedImages: [image],
        now: () => now,
        streamTransport: {
          async open(): Promise<never> {
            throw Error("uncertain stream dispatch");
          },
        },
      },
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
    const streamId = randomUUID();
    await manager.ports.expose(scope, "port", 8080);
    await assert.rejects(
      manager.streams!.open(scope, "port", streamId),
      /uncertain stream/,
    );
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
    if (
      failure === "release-ack" ||
      failure === "finalize-ack" ||
      failure === "upload"
    )
      await assert.rejects(
        manager.reconcile("alice"),
        failure === "upload" ? /interrupted upload/ : /release ACK lost/,
      );
    else await manager.reconcile("alice");
    manager = new SandboxManager(state, provider, transport, objects, options);
    if (failure === "upload") {
      await assert.rejects(manager.reconcile("alice"), /interrupted upload/);
      assert.equal((await manager.get(scope))?.phase, "quarantined");
      assert.equal(actions.includes("remove"), false);
      assert.equal(actions.includes("release"), false);
      failUpload = false;
    }
    await manager.reconcile("alice");
    assert.equal((await manager.operation(scope, stopId))?.phase, "succeeded");
    assert.equal((await manager.get(scope))?.phase, "stopped");
    assert.equal(
      (await manager.streams!.status(scope, streamId)).phase,
      "cancelled",
    );
    assert.ok(actions.indexOf("quiesce") < actions.indexOf("stream-status"));
    assert.ok(actions.indexOf("stream-status") < actions.indexOf("capture"));
    if (failure === "none") {
      assert.ok((await manager.get(scope))?.lease, "checkpoint retains host");
      assert.equal(actions.includes("remove"), false);
      const heldResume = randomUUID();
      await manager.resume(scope, heldResume);
      await assert.rejects(
        manager.deleteSandbox(scope, randomUUID()),
        /Resume transition pending/,
      );
      failRelease = true;
      await assert.rejects(manager.reconcile("alice"), /release ACK lost/);
      manager = new SandboxManager(
        state,
        provider,
        transport,
        objects,
        options,
      );
      await manager.reconcile("alice");
      assert.equal((await manager.get(scope))?.phase, "running");
      assert.equal((await manager.get(scope))?.generation, 2);
      assert.equal(
        (await manager.operation(scope, heldResume))?.phase,
        "succeeded",
      );
      assert.deepEqual(Buffer.concat(imported), archive);
      imported.length = 0;
      await manager.resume(scope, heldResume);
      await manager.reconcile("alice");
      assert.equal(
        imported.length,
        0,
        "held resume replay never repeats import",
      );
      await manager.stop(scope, randomUUID());
      await manager.reconcile("alice");
    }
    assert.equal((await manager.get(scope))?.lease, null);
    if (failure === "finalize-ack") {
      assert.ok(
        actions.indexOf("read-checkpoint") < actions.indexOf("finalize"),
      );
      assert.equal(actions.filter((action) => action === "finalize").length, 2);
      assert.equal(actions.includes("remove"), false);
      assert.equal(actions.includes("release"), false);
      assert.equal(actions.includes("purge-source"), false);
    } else {
      assert.ok(actions.indexOf("read-checkpoint") < actions.indexOf("remove"));
      assert.ok(actions.indexOf("release") < actions.indexOf("purge-source"));
    }
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
    const oldGeneration = failure === "none" ? 2 : 1;
    const registry = new CheckpointRegistry(state, objects),
      oldFence = { ...scope, generation: oldGeneration };
    await assert.rejects(manager.resume(scope, stopId), /identity conflict/);
    assert.equal(
      (await manager.get(scope))?.generation,
      oldGeneration,
      "conflicting operation rolls back both generations",
    );
    await registry.admit(
      oldFence,
      "reader-before-resume",
      "reader",
      (await manager.get(scope))!.checkpoint!,
    );
    await assert.rejects(
      manager.resume(scope, randomUUID()),
      /actors still active/,
    );
    await registry.close(oldFence, "reader-before-resume");
    const resumeId = randomUUID();
    await manager.resume(scope, resumeId);
    await assert.rejects(
      registry.admit(oldFence, "stale-writer", "writer"),
      /generation mismatch/,
    );
    if (failure === "missing-idle") {
      const root = (await manager.get(scope))!.checkpoint!;
      const before = actions.length;
      oldHostState = "unknown";
      await manager.reconcile("alice");
      assert.equal((await manager.get(scope))?.phase, "queued");
      assert.equal((await manager.get(scope))?.lease, null);
      assert.equal(allocations, 1, "ambiguity cannot allocate a replacement");
      assert.equal(retirements, 0);
      assert.equal(actions.length, before);
      oldHostState = "absent";
      await assert.rejects(manager.reconcile("alice"), /retirement ACK lost/);
      assert.equal(
        allocations,
        1,
        "uncertain retirement keeps capacity reserved",
      );
      assert.equal((await manager.get(scope))?.checkpoint, root);
      manager = new SandboxManager(
        state,
        provider,
        transport,
        objects,
        options,
      );
      await manager.reconcile("alice");
      const restored = await manager.get(scope);
      assert.equal(restored?.phase, "running");
      assert.equal(restored?.lease?.machineId, "replacement");
      assert.equal(restored?.generation, oldGeneration + 1);
      assert.equal(restored?.checkpoint, root);
      assert.equal(
        (await manager.operation(scope, resumeId))?.phase,
        "succeeded",
      );
      assert.equal(allocations, 2);
      assert.equal(retirements, 2);
      assert.deepEqual(
        Buffer.concat(imported),
        archive,
        "replacement imports exact durable bytes",
      );
      await manager.resume(scope, resumeId);
      await manager.reconcile("alice");
      assert.equal(allocations, 2, "resume replay cannot allocate again");
      return;
    }
    manager = new SandboxManager(state, provider, transport, objects, options);
    await manager.reconcile("alice");
    assert.equal((await manager.get(scope))?.phase, "running");
    assert.equal((await manager.get(scope))?.generation, oldGeneration + 1);
    assert.equal(
      (await manager.get(scope))?.lease?.generation,
      oldGeneration + 1,
    );
    assert.deepEqual(Buffer.concat(imported), archive);
    now += DEFAULTS.idleMs;
    await manager.reconcile("alice");
    assert.equal(retirements, 0, "an active assignment is never idle-retired");
    const afterResume = actions.length;
    await manager.resume(scope, resumeId);
    await manager.reconcile("alice");
    assert.equal(
      actions.length,
      afterResume,
      "resume replay does not reimport or create",
    );
    await manager.stop(scope, randomUUID());
    await manager.reconcile("alice");
    assert.equal((await manager.get(scope))?.phase, "stopped");
    assert.equal(allocations, 1, "resume reuses warm host");
    now += DEFAULTS.idleMs - 1;
    await manager.reconcile("alice");
    assert.equal(retirements, 0, "retain host for full idle window");
    now++;
    await assert.rejects(manager.reconcile("alice"), /retirement ACK lost/);
    assert.equal(retirements, 1);
    manager = new SandboxManager(state, provider, transport, objects, options);
    await manager.reconcile("alice");
    assert.equal(
      retirements,
      2,
      "restart reconciles the same allocation retirement",
    );
    await manager.reconcile("alice");
    assert.equal(retirements, 2, "completed retirement is not redispatched");
    assert.equal(
      allocations,
      1,
      "zero warm minimum does not replenish idle hosts",
    );
    const fresh = randomUUID();
    await manager.create("alice", fresh, image, randomUUID());
    await manager.reconcile("alice");
    assert.equal(allocations, 2);
    assert.equal(
      (await manager.get({ owner: "alice", sandbox: fresh }))?.lease
        ?.generation,
      oldGeneration + 2,
    );
    const freshScope = { owner: "alice", sandbox: fresh },
      deletion = randomUUID();
    await manager.deleteSandbox(freshScope, deletion);
    manager = new SandboxManager(state, provider, transport, objects, options);
    await manager.reconcile("alice");
    assert.equal((await manager.get(freshScope))?.phase, "deleted");
    assert.equal((await manager.get(freshScope))?.lease, null);
    assert.equal(
      (await manager.operation(freshScope, deletion))?.phase,
      "succeeded",
    );
    assert.ok(
      await registry.root({ ...freshScope, generation: 1 }, deletion),
      "deletion preserves its acknowledged checkpoint",
    );
    await assert.rejects(
      manager.resume(freshScope, randomUUID()),
      /released checkpoint/,
    );
    await assert.rejects(
      manager.startCommand(freshScope, randomUUID(), ["true"]),
      /not running/,
    );
    const beforeReplay = actions.length;
    await manager.deleteSandbox(freshScope, deletion);
    await manager.reconcile("alice");
    assert.equal(
      actions.length,
      beforeReplay,
      "deleted replay does not touch host",
    );
    const releasedDeletion = randomUUID();
    await manager.deleteSandbox(scope, releasedDeletion);
    assert.equal((await manager.get(scope))?.phase, "deleted");
    assert.equal(
      actions.length,
      beforeReplay,
      "released deletion needs no host",
    );
    assert.ok(
      await registry.root({ ...scope, generation: oldGeneration + 1 }, stopId),
    );
    await assert.rejects(
      manager.deleteSandbox({ owner: "bob", sandbox: fresh }, randomUUID()),
      /unavailable/,
    );
  });

test("release verification drains parallel checks and retains source on integrity failure", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "jetski-release-verification-"),
  );
  const state = new SqliteState(join(directory, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const objects = new LocalCheckpointStore(join(directory, "objects"));
  const compressed = ["one", "two", "three", "four"].map((part) =>
    gzipSync(Buffer.from(part)),
  );
  const archive = Buffer.concat(compressed);
  let offset = 0;
  const manifest = {
    version: 1,
    sha256: sha(archive),
    bytes: archive.length,
    expandedBytes: 15,
    entries: 2,
    frames: compressed.map((part, index) => {
      const raw = Buffer.from(["one", "two", "three", "four"][index]!);
      const frame = {
        offset,
        bytes: part.length,
        expandedBytes: raw.length,
        sha256: sha(part),
        expandedSha256: sha(raw),
      };
      offset += part.length;
      return frame;
    }),
  };
  const scope = { owner: "alice", sandbox: randomUUID() },
    fence = { ...scope, generation: 1 };
  const actions: string[] = [];
  const provider: HostProvider = {
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
  };
  const transport: HostTransport = {
    request: async (_host, request) => {
      actions.push(request.action);
      let result: Json = null;
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
  const manager = new SandboxManager(state, provider, transport, objects, {
    poolId: "pool",
    approvedImages: [image],
  });
  await manager.create(scope.owner, scope.sandbox, image, randomUUID());
  await manager.reconcile(scope.owner);
  const stop = randomUUID();
  await manager.stop(scope, stop);
  const registry = new CheckpointRegistry(state, objects),
    head = objects.head.bind(objects);
  const pending: ((corrupt?: boolean) => void)[] = [];
  let started!: () => void;
  const allStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  objects.head = async (address) => {
    if (!(await registry.root(fence, stop))) return head(address);
    return new Promise((resolve, reject) => {
      pending.push((corrupt) => {
        if (corrupt) resolve(undefined);
        else void head(address).then(resolve, reject);
      });
      if (pending.length === 4) started();
    });
  };
  let settled = false;
  const reconciling = manager.reconcile(scope.owner).finally(() => {
    settled = true;
  });
  const rejected = assert.rejects(
    reconciling,
    /Published checkpoint integrity failure/,
  );
  await allStarted;
  pending[0]!(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    settled,
    false,
    "release waits for all started integrity checks",
  );
  assert.equal(actions.includes("remove"), false);
  for (const release of pending.slice(1)) release();
  await rejected;
  assert.equal((await manager.get(scope))?.phase, "quarantined");
  assert.equal(actions.includes("remove"), false);
  assert.ok(await registry.root(fence, stop), "durable checkpoint is retained");
  objects.head = head;
  await manager.reconcile(scope.owner);
  assert.equal((await manager.get(scope))?.phase, "stopped");
  assert.equal(actions.includes("release"), true);
});
