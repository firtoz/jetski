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
for (const mode of [
  undefined,
  512 * 1024,
  4 * 1024 * 1024,
  16 * 1024 * 1024,
  "pipeline",
] as const) {
  const pipeline = mode === "pipeline";
  const chunkBytes = pipeline ? 16 * 1024 * 1024 : mode;
  const binary = chunkBytes === 16 * 1024 * 1024;
  test(`restore coalesces frames and resumes across boundaries with chunk bound ${mode ?? "legacy"}`, async (t) => {
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
    let frameBytes = 300_000;
    if (binary) frameBytes = 3_000_000;
    else if (chunkBytes === 4 * 1024 * 1024) frameBytes = 2_000_000;
    let frameCount = 3;
    if (binary) frameCount = 6;
    if (pipeline) frameCount = 13;
    const raw = randomBytes(frameBytes * frameCount);
    const compressed = Array.from(
      { length: frameCount },
      (_, i) => i * frameBytes,
    ).map((offset) => gzipSync(raw.subarray(offset, offset + frameBytes)));
    const archive = Buffer.concat(compressed),
      id = randomUUID();
    let frameOffset = 0;
    const manifest = {
      version: 1,
      sha256: sha(archive),
      bytes: archive.length,
      expandedBytes: raw.length,
      entries: 2,
      frames: compressed.map((frame, index) => {
        const value = {
          offset: frameOffset,
          bytes: frame.length,
          sha256: sha(frame),
          expandedBytes: frameBytes,
          expandedSha256: sha(
            raw.subarray(index * frameBytes, (index + 1) * frameBytes),
          ),
        };
        frameOffset += frame.length;
        return value;
      }),
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
      ...(chunkBytes
        ? { chunkBytes: binary ? 4 * 1024 * 1024 : chunkBytes }
        : {}),
      ...(binary ? { fileChunkBytes: chunkBytes } : {}),
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
    let opened = 0,
      closed = 0,
      stagedCount = 0,
      uploading = 0;
    const stageOffsets: number[] = [];
    let failStage = pipeline;
    const openImport = binary
      ? async () => {
          opened++;
          const sink = {
            chunkBytes: 16 * 1024 * 1024,
            ...(pipeline
              ? {
                  stage: async (
                    offset: number,
                    bytes: Uint8Array<ArrayBuffer>,
                    digest: string,
                  ) => {
                    stagedCount++;
                    stageOffsets.push(offset);
                    uploading++;
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    uploading--;
                    if (failStage && offset === 0) {
                      failStage = false;
                      throw Error("staging upload lost");
                    }
                    return () => sink.write(offset, bytes, digest);
                  },
                }
              : {}),
            write: async (
              offset: number,
              bytes: Uint8Array<ArrayBuffer>,
              digest: string,
            ) => {
              assert.equal(offset, receipt.offset);
              assert.equal(sha(bytes), digest);
              received.push(Buffer.from(bytes));
              offsets.push(offset);
              receipt.offset += bytes.length;
              if (loseAck) {
                if (pipeline)
                  assert.equal(
                    stagedCount,
                    2,
                    "next upload must precede first commit",
                  );
                loseAck = false;
                throw Error("lost acknowledgement");
              }
              return { ...receipt };
            },
            close: async () => {
              assert.equal(
                uploading,
                0,
                "all uploads must settle before temporary-path cleanup",
              );
              closed++;
            },
          };
          return sink;
        }
      : undefined;
    if (pipeline) {
      await assert.rejects(
        restoreCheckpoint(objects, registry, fence, id, request, openImport),
        /staging upload lost/,
      );
      assert.equal(receipt.offset, 0, "staging must never acknowledge bytes");
      stagedCount = 0;
      stageOffsets.length = 0;
    }
    await assert.rejects(
      restoreCheckpoint(objects, registry, fence, id, request, openImport),
      /lost acknowledgement/,
    );
    const bound = chunkBytes ?? 256 * 1024;
    assert.equal(receipt.offset, bound);
    await restoreCheckpoint(objects, registry, fence, id, request, openImport);
    assert.deepEqual(
      offsets,
      Array.from(
        { length: Math.ceil(archive.length / bound) },
        (_, i) => i * bound,
      ),
    );
    assert.deepEqual(Buffer.concat(received), archive);
    if (pipeline) {
      assert.equal(stageOffsets.filter((offset) => offset === 0).length, 1);
      assert.equal(
        stageOffsets.filter((offset) => offset === bound).length,
        2,
        "unacknowledged staged bytes are uploaded again after restart",
      );
    }
    await restoreCheckpoint(objects, registry, fence, id, request, openImport);
    assert.equal(finishes, 1);
    receipt.phase = "extracting";
    await restoreCheckpoint(objects, registry, fence, id, request, openImport);
    assert.equal(finishes, 2);
    let expectedOpened = 0;
    if (binary) expectedOpened = 2;
    if (pipeline) expectedOpened = 3;
    assert.equal(opened, expectedOpened);
    assert.equal(closed, opened);
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
}

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
