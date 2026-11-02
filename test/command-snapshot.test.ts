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

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const errors = new Map<string, RegExp>([
  ["corrupt", /Output proof integrity failure/],
  ["unsupported", /Invalid command output snapshot/],
  ["unsettled", /Unsettled command output snapshot/],
]);
for (const when of [
  "start",
  "status",
  "lost-ack",
  "corrupt",
  "unsupported",
  "unsettled",
] as const)
  test(`terminal output proof recovery: ${when}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "jetski-command-snapshot-")),
      path = join(directory, "state.sqlite");
    let state = new SqliteState(path);
    t.after(async () => {
      state.close();
      await rm(directory, { recursive: true, force: true });
    });
    const objects = new LocalCheckpointStore(join(directory, "objects")),
      scope = { owner: "owner", sandbox: randomUUID() },
      image = "example/linux@sha256:" + "a".repeat(64),
      id = randomUUID(),
      data = Buffer.from([0, 255, 128, 13, 10]);
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
    const raw = Buffer.from("filesystem fixture"),
      archive = gzipSync(raw),
      manifest = {
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
    let starts = 0;
    const actions: string[] = [];
    const status = { id, phase: "succeeded", exitCode: 0 };
    const result = () => ({
      ...status,
      ...(when === "unsettled" ? { phase: "running" } : {}),
      outputSnapshot: {
        version: when === "unsupported" ? 2 : 1,
        channels: {
          stdout: {
            base64: data.toString("base64"),
            sha256: when === "corrupt" ? "0".repeat(64) : sha(data),
          },
          stderr: { base64: "", sha256: sha(Buffer.alloc(0)) },
        },
      },
    });
    const transport: HostTransport = {
      request: async (_host, request) => {
        actions.push(request.action);
        let value: Json = null;
        if (request.action === "command-start") {
          starts++;
          assert.equal((request.payload as { waitMs: number }).waitMs, 250);
          if (when === "lost-ack") throw Error("start ACK lost");
          value = when === "status" ? { id, phase: "queued" } : result();
        }
        if (request.action === "command-status") value = result();
        if (request.action === "command-output")
          throw Error("host output source unavailable");
        if (request.action === "capture") value = manifest;
        if (request.action === "read-checkpoint") {
          const p = request.payload as { offset: number; bytes: number };
          value = {
            ...p,
            base64: archive
              .subarray(p.offset, p.offset + p.bytes)
              .toString("base64"),
          };
        }
        return { version: 1, id: request.id, result: value };
      },
    };
    const options = {
      poolId: "pool",
      approvedImages: [image],
      inlineCommandOutputBytes: 8192,
    };
    let manager = new SandboxManager(
      state,
      provider,
      transport,
      objects,
      options,
    );
    await manager.create(scope.owner, scope.sandbox, image, randomUUID());
    await manager.reconcile(scope.owner);
    const expectedError = errors.get(when);
    if (expectedError) {
      await assert.rejects(
        manager.startCommand(scope, id, ["true"]),
        expectedError,
      );
      const stop = randomUUID();
      await manager.stop(scope, stop);
      await assert.rejects(manager.reconcile(scope.owner), expectedError);
      assert.equal((await manager.get(scope))?.phase, "quarantined");
      assert.ok(!actions.includes("remove"));
      assert.ok(!actions.includes("purge-source"));
      return;
    }
    if (when === "lost-ack")
      await assert.rejects(
        manager.startCommand(scope, id, ["true"]),
        /start ACK lost/,
      );
    else await manager.startCommand(scope, id, ["true"]);
    if (when === "status")
      assert.deepEqual(await manager.commandStatus(scope, id), status);
    state.close();
    state = new SqliteState(path);
    manager = new SandboxManager(state, provider, transport, objects, {
      ...options,
      commandStartWaitMs: 0,
    });
    assert.deepEqual(await manager.startCommand(scope, id, ["true"]), status);
    assert.equal(starts, 1, "uncertain start is observed, never replayed");
    for (const [offset, bytes] of [
      [0, 65536],
      [2, 2],
      [data.length, 1],
    ]) {
      const output = (await manager.commandOutput(
        scope,
        id,
        "stdout",
        offset!,
        bytes!,
      )) as { base64: string };
      assert.deepEqual(
        Buffer.from(output.base64, "base64"),
        data.subarray(offset, offset! + bytes!),
      );
    }
    assert.deepEqual(await manager.commandOutput(scope, id, "stderr", 0, 1), {
      base64: "",
      nextOffset: 0,
      terminal: true,
    });
    await assert.rejects(
      manager.commandOutput({ ...scope, owner: "foreign" }, id, "stdout", 0, 1),
    );
    await assert.rejects(
      manager.commandOutput(scope, id, "stdout", data.length + 1, 1),
      /cursor beyond end/,
    );
    const stop = randomUUID();
    await manager.stop(scope, stop);
    await manager.reconcile(scope.owner);
    assert.equal((await manager.operation(scope, stop))?.phase, "succeeded");
    assert.equal((await manager.get(scope))?.phase, "stopped");
    assert.equal(
      actions.includes("command-output"),
      false,
      "checkpoint retention reuses the exact durable output proof",
    );
    assert.equal(starts, 1);
    assert.deepEqual(await manager.commandStatus(scope, id), status);
    assert.deepEqual(
      await manager.commandOutput(scope, id, "stdout", 0, 65536),
      {
        base64: data.toString("base64"),
        nextOffset: data.length,
        terminal: true,
      },
    );
  });
