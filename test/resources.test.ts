import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HostProvider, Json } from "../src/core/contracts.js";
import { SandboxManager } from "../src/core/manager.js";
import { workloadResources } from "../src/core/resources.js";
import type { HostTransport } from "../src/core/transport.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

test("resource policy rejects unsupported or ambiguous limits", () => {
  for (const value of [
    null,
    [],
    {},
    { cpus: 0, memoryMb: 512 },
    { cpus: 1.5, memoryMb: 512 },
    { cpus: 65, memoryMb: 512 },
    { cpus: 1, memoryMb: 127 },
    { cpus: 1, memoryMb: 65537 },
    { cpus: 1, memoryMb: NaN },
    { cpus: 1, memoryMb: 512, memory: 1000 },
  ])
    assert.throws(() => workloadResources(value), /Invalid/);
});

for (const legacy of [false, true]) {
  test(`placement retains ${legacy ? "legacy defaults" : "persisted limits"} across controller restart`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "jetski-resources-"));
    const path = join(directory, "state.sqlite");
    let state = new SqliteState(path);
    t.after(async () => {
      state.close();
      await rm(directory, { recursive: true, force: true });
    });
    const image = `example/linux@sha256:${"a".repeat(64)}`;
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
    const payloads: Json[] = [];
    const transport: HostTransport = {
      request: async (_host, request) => {
        if (request.action === "create") payloads.push(request.payload);
        return { version: 1, id: request.id, result: { phase: "running" } };
      },
    };
    const policy = { cpus: 2, memoryMb: 2048 };
    const open = (resources = policy) =>
      new SandboxManager(
        state,
        provider,
        transport,
        new LocalCheckpointStore(join(directory, "objects")),
        {
          poolId: "pool",
          approvedImages: [image],
          workloadResources: resources,
        },
      );
    const manager = open();
    policy.cpus = 8; // Constructor must own a copy of the operator policy.
    const id = randomUUID(),
      operation = randomUUID();
    const original = await manager.create("owner", id, image, operation);
    assert.deepEqual(original.resources, { cpus: 2, memoryMb: 2048 });
    if (legacy)
      await state.transaction((tx) => {
        for (const { key, value } of tx.scan("sandbox/")) {
          const record = value as Record<string, Json>;
          delete record.resources;
          tx.put(key, record);
        }
      });
    state.close();
    state = new SqliteState(path);
    const restarted = open({ cpus: 4, memoryMb: 4096 });
    const replay = await restarted.create("owner", id, image, operation);
    assert.deepEqual(replay.resources, legacy ? undefined : original.resources);
    await restarted.reconcile("owner");
    assert.equal(payloads.length, 1);
    const payload = payloads[0] as Record<string, Json>;
    assert.equal(payload.cpus, legacy ? 1 : 2);
    assert.equal(payload.memoryMb, legacy ? 512 : 2048);
    assert.equal(
      (await restarted.get({ owner: "owner", sandbox: id }))?.phase,
      "running",
    );
  });
}
