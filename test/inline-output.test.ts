import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CheckpointRegistry } from "../src/core/checkpoints.js";
import {
  CommandOutputStore,
  encodeBase64,
  validateOutputRoot,
} from "../src/core/command-output.js";
import { DEFAULTS, type Json } from "../src/core/contracts.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";

for (const fault of ["journal", "publication"] as const)
  test(`inline outputs survive ${fault} ACK loss, restart and absent source`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "jetski-inline-")),
      path = join(dir, "state.sqlite");
    let state = new SqliteState(path);
    t.after(async () => {
      state.close();
      await rm(dir, { recursive: true, force: true });
    });
    const store = new LocalCheckpointStore(join(dir, "objects")),
      fence = { owner: "alice", sandbox: "sandbox", generation: 1 };
    let registry = new CheckpointRegistry(state, store, () => 0),
      output = new CommandOutputStore(store, registry, 8192);
    await registry.initialize(fence);
    const id = randomUUID(),
      status = { id, phase: "succeeded", exitCode: 0 },
      data = {
        stdout: Buffer.alloc(8192, 255),
        stderr: Buffer.alloc(fault === "journal" ? 8193 : 7, 128),
      };
    let puts = 0;
    const put = store.put.bind(store);
    store.put = async (...args) => {
      puts++;
      return put(...args);
    };
    const source = async (channel: string, offset: number, count: number) => {
      const bytes = data[channel as keyof typeof data].subarray(
        offset,
        offset + count,
      );
      return {
        base64: bytes.toString("base64"),
        nextOffset: offset + bytes.length,
        terminal:
          offset + bytes.length === data[channel as keyof typeof data].length,
      };
    };
    if (fault === "journal") {
      const plan = registry.planStreamPart.bind(registry);
      let lose = true;
      registry.planStreamPart = async (...args) => {
        await plan(...args);
        if (lose) {
          lose = false;
          throw Error("journal ACK lost");
        }
      };
    } else {
      const publish = registry.publish.bind(registry);
      registry.publish = async (...args) => {
        await publish(...args);
        throw Error("publication ACK lost");
      };
    }
    await assert.rejects(output.retain(fence, id, status, source), /ACK lost/);
    if (fault === "journal")
      await assert.rejects(registry.collect(fence, "blocked"), /Active/);
    state.close();
    state = new SqliteState(path);
    registry = new CheckpointRegistry(state, store, () => 0);
    output = new CommandOutputStore(store, registry, 0);
    await output.retain(fence, id, status, async (channel, offset, count) => {
      assert.equal(fault, "journal");
      assert.equal(
        channel,
        "stderr",
        "persisted inline bytes never reread after restart/settings change",
      );
      return source(channel, offset, count);
    });
    assert.equal(puts, fault === "journal" ? 1 : 0);
    for (const channel of ["stdout", "stderr"] as const) {
      for (const offset of [0, 13, data[channel].length]) {
        const result = await output.read(
          fence,
          id,
          channel,
          Math.min(offset, data[channel].length),
          211,
        );
        assert.deepEqual(
          Buffer.from(result.base64, "base64"),
          data[channel].subarray(offset, offset + 211),
        );
      }
    }
    assert.deepEqual(await output.retained(fence, id), status);
    await assert.rejects(
      output.read({ ...fence, owner: "foreign" }, id, "stdout", 0, 1),
    );
    await assert.rejects(
      output.read({ ...fence, generation: 2 }, id, "stdout", 0, 1),
    );
    const root = await registry.root(fence, `command-${id}`);
    assert.ok(root);
    const metadata = validateOutputRoot(root, id);
    assert.equal(metadata.version, 2);
    assert.equal(root.frames.length, fault === "journal" ? 1 : 0);
    const invalid = structuredClone(root);
    (invalid.metadata as Record<string, Json>).channels = {
      stdout: [0],
      stderr: [],
    };
    assert.throws(() => validateOutputRoot(invalid));
  });

test("inline corruption fails publication/read and blocks eligible orphan collection", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jetski-inline-gc-"));
  const state = new SqliteState(join(dir, "state.sqlite"));
  t.after(async () => {
    state.close();
    await rm(dir, { recursive: true, force: true });
  });
  const store = new LocalCheckpointStore(join(dir, "objects"));
  let now = 0;
  const registry = new CheckpointRegistry(state, store, () => now),
    output = new CommandOutputStore(store, registry, 8192),
    fence = { owner: "alice", sandbox: "box", generation: 1 };
  await registry.initialize(fence);
  const id = randomUUID(),
    status = { id, phase: "succeeded", exitCode: 0 };
  await output.retain(fence, id, status, async (channel) => ({
    base64: channel === "stdout" ? "AP8=" : "",
    nextOffset: channel === "stdout" ? 2 : 0,
    terminal: true,
  }));
  const bytes = Buffer.from("owned orphan"),
    orphan = {
      owner: fence.owner,
      sandbox: fence.sandbox,
      id: randomUUID(),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  await store.put(
    orphan,
    (async function* () {
      yield bytes;
    })(),
    orphan,
  );
  assert.equal((await registry.collect(fence, "observe")).deleted, 0);
  await state.transaction((tx) => {
    const key = `checkpoint/${fence.owner}/${fence.sandbox}`;
    const value = tx.get(key) as {
      roots: Array<{
        id: string;
        metadata: { inline: { stdout: { base64: string } } };
      }>;
    };
    value.roots.find(
      (r) => r.id === `command-${id}`,
    )!.metadata.inline.stdout.base64 = "Af8=";
    tx.put(key, value);
  });
  await assert.rejects(
    output.read(fence, id, "stdout", 0, 2),
    /Inline output integrity failure/,
  );
  now = DEFAULTS.gcGraceMs + 1;
  await assert.rejects(
    registry.collect(fence, "collect"),
    /Inline output integrity failure/,
  );
  assert.ok(await store.head(orphan));
  // Restore the independent fixture's known original bytes, then resume the
  // same failed collector identity; retained inline history remains exact.
  await state.transaction((tx) => {
    const key = `checkpoint/${fence.owner}/${fence.sandbox}`;
    const value = tx.get(key) as {
      roots: Array<{
        id: string;
        metadata: { inline: { stdout: { base64: string } } };
      }>;
    };
    value.roots.find(
      (root) => root.id === `command-${id}`,
    )!.metadata.inline.stdout.base64 = "AP8=";
    tx.put(key, value);
  });
  assert.equal((await registry.collect(fence, "collect")).deleted, 1);
  assert.equal((await registry.collect(fence, "collect")).deleted, 1);
  assert.equal(await store.head(orphan), undefined);
  assert.equal((await output.read(fence, id, "stdout", 0, 2)).base64, "AP8=");

  const other = { ...fence, sandbox: "other" };
  await registry.initialize(other);
  await registry.admit(other, "writer", "writer");
  await assert.rejects(
    registry.publish(other, "writer", `command-${id}`, [], {
      kind: "command-output",
      version: 2,
      commandId: id,
      status,
      channels: { stdout: [], stderr: [] },
      inline: {
        stdout: { base64: "AP8=", sha256: "0".repeat(64) },
        stderr: null,
      },
    }),
    /Inline output integrity failure/,
  );
  for (const inline of [-1, NaN, 8193, 0.5])
    assert.throws(
      () => new CommandOutputStore(store, registry, inline),
      /Invalid inline output policy/,
    );
  assert.equal(encodeBase64(Uint8Array.of(0, 255)), "AP8=");
});
