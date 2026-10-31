import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CheckpointRegistry } from "../src/core/checkpoints.js";
import {
  CommandOutputStore,
  decodeBase64,
  encodeBase64,
  OUTPUT_CHUNK,
} from "../src/core/command-output.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

for (const failure of [false, true])
  test(`durable binary command output: interrupted=${failure}`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "jetski-output-"));
    const state = new SqliteState(join(dir, "state.sqlite"));
    t.after(async () => {
      state.close();
      await rm(dir, { recursive: true, force: true });
    });
    const store = new LocalCheckpointStore(join(dir, "objects"));
    const registry = new CheckpointRegistry(state, store);
    const output = new CommandOutputStore(store, registry);
    const fence = { owner: "alice", sandbox: "box", generation: 1 };
    await registry.initialize(fence);
    const id = crypto.randomUUID();
    const status = { id, phase: "succeeded", exitCode: 0 };
    const data = Uint8Array.from(
      { length: OUTPUT_CHUNK + 37 },
      (_, i) => i % 256,
    );
    const save = () =>
      output.retain(fence, id, status, async (channel, offset, count) => {
        if (failure && offset) throw Error("connection lost");
        const part =
          channel === "stdout"
            ? data.subarray(offset, offset + count)
            : new Uint8Array();
        return {
          base64: encodeBase64(part),
          nextOffset: offset + part.length,
          terminal:
            channel === "stderr" || offset + part.length === data.length,
        };
      });
    if (failure) {
      await assert.rejects(save(), /connection lost/);
      assert.equal(await output.retained(fence, id), undefined);
      await assert.rejects(registry.collect(fence, "collection"), /Active/);
      return;
    }
    await save();
    await output.retain(fence, id, status, async () => {
      throw Error("source deleted");
    });
    assert.deepEqual(await output.retained(fence, id), status);
    const segment = await output.read(
      fence,
      id,
      "stdout",
      OUTPUT_CHUNK - 11,
      48,
    );
    assert.deepEqual(
      decodeBase64(segment.base64),
      data.subarray(OUTPUT_CHUNK - 11),
    );
    assert.equal(segment.terminal, true);
    assert.deepEqual(await output.read(fence, id, "stderr", 0, 1), {
      base64: "",
      nextOffset: 0,
      terminal: true,
    });
    await assert.rejects(
      output.read(fence, id, "stdout", data.length + 1, 1),
      /beyond end/,
    );
    await assert.rejects(
      output.retain(fence, id, { ...status, exitCode: 1 }, async () => null),
      /identity conflict/,
    );
    await assert.rejects(
      output.read({ ...fence, owner: "bob" }, id, "stdout", 0, 1),
      /generation mismatch/,
    );
    const root = await registry.root(fence, `command-${id}`);
    assert.ok(root?.frames[0]);
    // Replace the store response rather than assuming adapter-specific disk layout.
    const original = store.read.bind(store);
    store.read = async function* (address, range) {
      if (address.id === root.frames[0]?.id) {
        yield new Uint8Array(OUTPUT_CHUNK);
        return;
      }
      yield* original(address, range);
    };
    await assert.rejects(
      output.read(fence, id, "stdout", 0, 1),
      /integrity failure/,
    );
  });
