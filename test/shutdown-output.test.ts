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

test("shutdown resumes multiple command outputs after committed upload loses acknowledgement", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-stop-output-"));
  const path = join(directory, "state.sqlite");
  let state = new SqliteState(path);
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const objects = new LocalCheckpointStore(join(directory, "objects"));
  const image = "example/linux@sha256:" + "a".repeat(64);
  const scope = { owner: "alice", sandbox: randomUUID() };
  const ids: string[] = Array.from({ length: 3 }, () => randomUUID()).sort();
  const statuses = new Map(
    ids.map((id, index) => [
      id,
      {
        id,
        phase: index === 0 ? "cancelled" : "succeeded",
        exitCode: index === 0 ? 143 : 0,
      },
    ]),
  );
  const payloads = new Map(
    ids.map((id, index) => [id, Buffer.from([index, 0, 255, 13])]),
  );
  const raw = Buffer.from("filesystem fixture"),
    archive = gzipSync(raw);
  const sha = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");
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
        sha256: sha(archive),
        expandedBytes: raw.length,
        expandedSha256: sha(raw),
      },
    ],
  };
  const actions: string[] = [];
  const statusCalls = new Map<string, number>();
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
      const input = request.payload as {
        commandId: string;
        channel: string;
        offset: number;
        bytes: number;
      };
      if (request.action === "command-status")
        statusCalls.set(
          input.commandId,
          (statusCalls.get(input.commandId) ?? 0) + 1,
        );
      let result: Json = null;
      if (
        ["command-start", "command-status", "command-cancel"].includes(
          request.action,
        )
      )
        result = statuses.get(input.commandId)!;
      if (request.action === "command-output") {
        const bytes =
          input.channel === "stdout"
            ? payloads.get(input.commandId)!
            : Buffer.alloc(0);
        result = {
          base64: bytes.subarray(input.offset).toString("base64"),
          nextOffset: bytes.length,
          terminal: true,
        };
      }
      if (request.action === "capture") result = manifest;
      if (request.action === "read-checkpoint")
        result = {
          ...input,
          base64: archive
            .subarray(input.offset, input.offset + input.bytes)
            .toString("base64"),
        };
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
  await manager.create(scope.owner, scope.sandbox, image, randomUUID());
  await manager.reconcile(scope.owner);
  for (const id of ids) await manager.startCommand(scope, id, ["true"]);
  await manager.cancelCommand(scope, ids[0]!);
  const put = objects.put.bind(objects);
  let puts = 0;
  let failed = false,
    drained = false,
    finished = false;
  let releaseSibling!: () => void;
  const sibling = new Promise<void>((resolve) => {
    releaseSibling = resolve;
  });
  objects.put = async (...args) => {
    const call = ++puts;
    const result = await put(...args);
    if (call === 1) {
      failed = true;
      throw Error("committed upload ACK lost");
    }
    if (call === 2) {
      await sibling;
      drained = true;
    }
    return result;
  };
  const stop = randomUUID();
  statusCalls.clear();
  await manager.stop(scope, stop);
  const reconciliation = manager.reconcile(scope.owner).finally(() => {
    finished = true;
  });
  // Attach rejection observation immediately; the sibling deliberately remains pending.
  const rejected = assert.rejects(reconciliation, /committed upload ACK lost/);
  for (let attempt = 0; !failed && attempt < 1000; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(failed, true);
  assert.equal(finished, false);
  assert.equal(drained, false);
  assert.equal(puts, 2, "no later command starts after a failed batch");
  assert.equal(
    statusCalls.get(ids[0]!),
    1,
    "use the observed terminal outcome without another host query",
  );
  releaseSibling();
  await rejected;
  assert.equal(drained, true);
  assert.ok(!actions.includes("release"));
  state.close();
  state = new SqliteState(path);
  manager = new SandboxManager(state, provider, transport, objects, options);
  await manager.reconcile(scope.owner);
  assert.equal((await manager.operation(scope, stop))?.phase, "succeeded");
  assert.equal(
    puts,
    4,
    "three output objects and one archive; no duplicate upload",
  );
  for (const id of ids) {
    assert.deepEqual(await manager.commandStatus(scope, id), statuses.get(id));
    const output = (await manager.commandOutput(
      scope,
      id,
      "stdout",
      0,
      100,
    )) as { base64: string };
    assert.deepEqual(Buffer.from(output.base64, "base64"), payloads.get(id));
  }
});
