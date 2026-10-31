import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { CheckpointRegistry } from "../src/core/checkpoints.js";
import type { Json } from "../src/core/contracts.js";
import { restoreCheckpoint } from "../src/core/restore.js";
import { CheckpointTransfer } from "../src/core/transfer.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
test("restore resumes a durable partial frame after lost acknowledgement and validates receipts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-restore-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const objects = new LocalCheckpointStore(join(directory, "objects"));
  const registry = new CheckpointRegistry(state, objects),
    fence = { owner: "alice", sandbox: "box", generation: 1 };
  await registry.initialize(fence);
  const raw = randomBytes(700000),
    archive = gzipSync(raw),
    id = randomUUID();
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
  await new CheckpointTransfer(objects, registry).save(fence, id, manifest, {
    read: async (offset, count) => archive.subarray(offset, offset + count),
  });
  const receipt = {
    id,
    sha256: manifest.sha256,
    bytes: archive.length,
    offset: 0,
    phase: "receiving",
  };
  const offsets: number[] = [],
    received: Buffer[] = [];
  let loseAck = true,
    finishes = 0;
  const request = async (action: string, payload: Json): Promise<Json> => {
    if (action === "import-begin") return { ...receipt };
    if (action === "import-chunk") {
      const part = payload as {
        offset: number;
        base64: string;
        sha256: string;
      };
      assert.equal(part.offset, receipt.offset);
      const bytes = Buffer.from(part.base64, "base64");
      assert.equal(sha(bytes), part.sha256);
      received.push(bytes);
      offsets.push(part.offset);
      receipt.offset += bytes.length;
      if (loseAck) {
        loseAck = false;
        throw Error("lost acknowledgement");
      }
      return { ...receipt };
    }
    assert.equal(action, "import-finish");
    finishes++;
    assert.equal(receipt.offset, receipt.bytes);
    receipt.phase = "ready";
    return { ...receipt };
  };
  await assert.rejects(
    restoreCheckpoint(objects, registry, fence, id, request),
    /lost acknowledgement/,
  );
  assert.equal(receipt.offset, 256 * 1024);
  await restoreCheckpoint(objects, registry, fence, id, request);
  assert.deepEqual(offsets, [0, 256 * 1024, 512 * 1024]);
  assert.deepEqual(Buffer.concat(received), archive);
  await restoreCheckpoint(objects, registry, fence, id, request);
  assert.equal(finishes, 1);
  receipt.phase = "extracting";
  await restoreCheckpoint(objects, registry, fence, id, request);
  assert.equal(finishes, 2);
  await assert.rejects(
    restoreCheckpoint(objects, registry, fence, id, async () => ({
      ...receipt,
      offset: -1,
    })),
    /Invalid import receipt/,
  );
  receipt.phase = "extracting";
  await assert.rejects(
    restoreCheckpoint(objects, registry, fence, id, async (action) =>
      action === "import-begin"
        ? { ...receipt }
        : { ...receipt, phase: "receiving" },
    ),
    /completed import receipt/,
  );
});

test("restore rejects a corrupt frame map before contacting the host", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-restore-invalid-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const objects = new LocalCheckpointStore(join(directory, "objects"));
  const registry = new CheckpointRegistry(state, objects);
  const fence = { owner: "owner", sandbox: "box", generation: 1 };
  const digest = "a".repeat(64);
  await state.transaction((tx) =>
    tx.put("checkpoint/owner/box", {
      generation: 1,
      collection: null,
      accesses: [],
      roots: [
        {
          id: "root",
          frames: [],
          publishedAt: 1,
          retiredAt: null,
          pins: [],
          metadata: {
            version: 1,
            sha256: digest,
            bytes: 1,
            expandedBytes: 1,
            entries: 2,
            frames: [
              {
                offset: 0,
                bytes: 1,
                expandedBytes: 1,
                sha256: digest,
                expandedSha256: digest,
              },
            ],
          },
        },
      ],
    }),
  );
  let requests = 0;
  await assert.rejects(
    restoreCheckpoint(objects, registry, fence, "root", async () => {
      requests++;
      return {
        id: "root",
        sha256: digest,
        bytes: 1,
        offset: 1,
        phase: "ready",
      };
    }),
    /payload frame count/,
  );
  assert.equal(requests, 0);
  const persisted = (await registry.inspect(fence)) as { accesses: unknown[] };
  assert.deepEqual(
    persisted.accesses,
    [],
    "failed validation releases its reader admission",
  );
});
