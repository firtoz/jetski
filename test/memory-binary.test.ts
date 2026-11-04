import assert from "node:assert/strict";
import { test } from "node:test";
import type { Json } from "../src/core/contracts.js";
import type { CapturedMemory } from "../src/core/memory-capture.js";
import type { HostLease } from "../src/core/pool.js";
import { BoatApi } from "../src/providers/boat.js";
import {
  boatMemoryImport,
  boatMemorySource,
} from "../src/transport/memory-binary.js";

const lease: HostLease = {
  owner: "owner",
  poolId: "pool",
  machineId: "bx_host",
  sandboxId: "sandbox",
  assignmentId: "11111111-1111-4111-8111-111111111111",
  slotId: "slot",
  generation: 2,
};
const id = "22222222-2222-4222-8222-222222222222";
const capture = { sha256: "a".repeat(64), bytes: 8 } as CapturedMemory;
const base = `${lease.assignmentId}-g2/${id}`;
test("binary source is lazy, scoped and reads only requested ranges, with bounded fallback", async () => {
  let downloads = 0,
    closes = 0;
  const actions: string[] = [];
  const api = {
    async openDownload(
      host: string,
      path: string,
      bytes: number,
      options: unknown,
    ) {
      assert.equal(host, lease.machineId);
      assert.equal(path, `/tmp/jetski-memory-exports/${base}/memory.pack`);
      assert.equal(bytes, 8);
      assert.equal(options, undefined);
      downloads++;
      return {
        read: async (offset: number, count: number) =>
          new Uint8Array(count).fill(offset),
        close: async () => {
          closes++;
        },
      };
    },
  } as unknown as BoatApi;
  const request = async (action: string): Promise<Json> => {
    actions.push(action);
    return action === "memory-source"
      ? {
          path: `/tmp/jetski-memory-exports/${base}/memory.pack`,
          sha256: capture.sha256,
          bytes: 8,
        }
      : { closed: true };
  };
  const unused = boatMemorySource(
    api,
    lease.machineId,
    lease,
    id,
    capture,
    request,
  );
  await unused.close?.();
  assert.deepEqual(actions, ["memory-source-close"]);
  const source = boatMemorySource(
    api,
    lease.machineId,
    lease,
    id,
    capture,
    request,
  );
  assert.deepEqual(await source.read(3, 2), new Uint8Array([3, 3]));
  assert.equal(downloads, 1);
  await source.close?.();
  assert.equal(closes, 1);
  assert.deepEqual(actions, [
    "memory-source-close",
    "memory-source",
    "memory-source-close",
  ]);
  const fallback = boatMemorySource(
    api,
    lease.machineId,
    lease,
    id,
    capture,
    async (action) =>
      action === "memory-source-close"
        ? { closed: true }
        : action === "memory-source"
          ? { supported: false }
          : { offset: 3, bytes: 2, base64: "AwM=" },
  );
  assert.deepEqual(await fallback.read(3, 2), new Uint8Array([3, 3]));
  await fallback.close?.();
  assert.equal(downloads, 1);
});
test("binary input uploads only to negotiated scoped path and commits through host journal", async () => {
  const actions: string[] = [];
  let uploaded = 0;
  const api = {
    async uploadMemoryPart(host: string, path: string, bytes: Uint8Array) {
      assert.equal(host, lease.machineId);
      assert.equal(path, `/tmp/jetski-memory-imports/${base}/chunk.bin`);
      uploaded += bytes.length;
    },
  } as unknown as BoatApi;
  const sink = await boatMemoryImport(
    api,
    lease.machineId,
    lease,
    id,
    async (action, payload) => {
      actions.push(action);
      assert.equal(payload.checkpointId, id);
      if (action === "memory-import-file-begin")
        return {
          path: `/tmp/jetski-memory-imports/${base}/chunk.bin`,
          chunkBytes: 4 * 1024 * 1024,
        };
      if (action === "memory-import-file-close") return { closed: true };
      assert.equal(payload.offset, 0);
      assert.equal(payload.bytes, 2);
      return { id: "object", offset: 2, complete: true };
    },
  );
  assert(sink);
  assert.deepEqual(
    await sink.write("object", 0, new Uint8Array([0, 255]), "b".repeat(64)),
    { id: "object", offset: 2, complete: true },
  );
  await sink.close();
  assert.equal(uploaded, 2);
  assert.deepEqual(actions, [
    "memory-import-file-begin",
    "memory-import-file-chunk",
    "memory-import-file-close",
  ]);
  await assert.rejects(
    boatMemoryImport(api, lease.machineId, lease, id, async () => ({
      path: "/tmp/arbitrary",
      chunkBytes: 4 * 1024 * 1024,
    })),
    /identity/,
  );
});
test("provider memory uploads reject paths outside generation/checkpoint scope", async () => {
  const api = new BoatApi("test-only", async () => {
    throw Error("must not access provider");
  });
  for (const path of [
    "/tmp/arbitrary",
    `/tmp/jetski-memory-imports/${lease.assignmentId}/${id}/chunk.bin`,
    `/tmp/jetski-memory-imports/${lease.assignmentId}-g0/${id}/chunk.bin`,
  ])
    await assert.rejects(
      api.uploadMemoryPart(lease.machineId, path, new Uint8Array([1])),
      /Invalid memory upload path/,
    );
});
