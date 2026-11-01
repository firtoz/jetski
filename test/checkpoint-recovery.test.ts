import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CheckpointRegistry } from "../src/core/checkpoints.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

for (const scenario of [
  "recover",
  "reader",
  "writer",
  "unidentified",
  "retired",
  "published",
  "rollback",
])
  test(`missing source registry fence: ${scenario}`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "jetski-recovery-"));
    let state = new SqliteState(join(dir, "state.sqlite"));
    t.after(async () => {
      state.close();
      await rm(dir, { recursive: true, force: true });
    });
    const objects = new LocalCheckpointStore(join(dir, "objects"));
    let registry = new CheckpointRegistry(state, objects);
    const fence = { owner: "owner", sandbox: "sandbox", generation: 1 };
    const bytes = Buffer.from("acknowledged bytes\0");
    const frame = {
      ...fence,
      id: "object",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    await registry.initialize(fence);
    await objects.put(
      frame,
      (async function* () {
        yield bytes;
      })(),
      frame,
    );
    await registry.admit(fence, "first", "writer");
    await registry.publish(fence, "first", "retained", [frame]);
    if (scenario === "unidentified")
      await registry.admit(fence, "interrupted", "writer");
    else await registry.beginFrameSave(fence, "interrupted", null, [frame]);
    if (scenario === "reader")
      await registry.admit(fence, "reader", "reader", "retained");
    if (scenario === "writer") await registry.admit(fence, "other", "writer");
    if (scenario === "retired") await registry.retire(fence, "retained");
    if (scenario === "published")
      await registry.publish(fence, "interrupted", "interrupted", [frame]);
    const before = await state.transaction((tx) => tx.scan(""));
    if (scenario !== "recover") {
      await assert.rejects(
        state.transaction((tx) => {
          registry.recoverMissingSourceIn(tx, fence, "interrupted", "retained");
          if (scenario === "rollback") throw Error("Coordinator failed");
        }),
      );
      assert.deepEqual(await state.transaction((tx) => tx.scan("")), before);
      return;
    }
    const next = await state.transaction((tx) =>
      registry.recoverMissingSourceIn(tx, fence, "interrupted", "retained"),
    );
    assert.equal(next.generation, 2);
    state.close();
    state = new SqliteState(join(dir, "state.sqlite"));
    registry = new CheckpointRegistry(state, objects);
    assert.deepEqual((await registry.root(next, "retained"))?.frames, [frame]);
    assert.ok(await objects.head(frame));
    assert.deepEqual(
      await state.transaction((tx) => tx.scan("frame-save/")),
      before.filter((row) => row.key.startsWith("frame-save/")),
    );
    await assert.rejects(
      registry.beginFrameSave(fence, "interrupted", null, [frame]),
      /generation/,
    );
    await assert.rejects(
      registry.publish(fence, "interrupted", "interrupted", [frame]),
      /generation/,
    );
    await assert.rejects(
      state.transaction((tx) =>
        registry.recoverMissingSourceIn(tx, fence, "interrupted", "retained"),
      ),
      /generation/,
    );
    await assert.rejects(
      registry.beginFrameSave(next, "interrupted", null, [frame]),
      /identity/,
    );
    assert.equal(await registry.root(next, "interrupted"), undefined);
  });
