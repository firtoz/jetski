/** Disposable-runner qualification; environment paths are ephemeral credentials. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CheckpointRegistry,
  CheckpointTransfer,
  parseArchive,
} from "../src/core/index.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";
import { SshTransport } from "../src/transport/ssh.js";

const key = process.env.JETSKI_TEST_SSH_KEY;
const knownHosts = process.env.JETSKI_TEST_KNOWN_HOSTS;
const image = process.env.JETSKI_TEST_IMAGE;
if (!key || !knownHosts || !image)
  throw new Error("Missing qualification configuration");
const transport = new SshTransport([
  {
    id: "ssh-ci",
    hostname: "127.0.0.1",
    port: 2222,
    user: "root",
    privateKeyPath: key,
    knownHostsPath: knownHosts,
  },
]);
const wrongHosts = process.env.JETSKI_TEST_WRONG_HOSTS;
if (!wrongHosts) throw new Error("Missing wrong-host-key fixture");
const wrong = new SshTransport([
  {
    id: "ssh-ci",
    hostname: "127.0.0.1",
    port: 2222,
    user: "root",
    privateKeyPath: key,
    knownHostsPath: wrongHosts,
  },
]);
await assert.rejects(
  wrong.request("ssh-ci", {
    version: 1,
    id: randomUUID(),
    action: "status",
    payload: null,
  }),
);
const request = async (
  action: string,
  payload: import("../src/core/contracts.js").Json,
) =>
  (
    await transport.request("ssh-ci", {
      version: 1,
      id: randomUUID(),
      action,
      payload,
    })
  ).result;
const status = await request("status", null);
assert.ok(
  status &&
    typeof status === "object" &&
    !Array.isArray(status) &&
    status.ready === true,
);
const lease = {
  owner: "qualification",
  poolId: "ci",
  machineId: "ssh-ci",
  slotId: randomUUID(),
  sandboxId: randomUUID(),
  assignmentId: randomUUID(),
  generation: 1,
};
const payload = { lease, image };
await request("claim", { lease });
try {
  const created = await request("create", payload);
  assert.deepEqual(await request("create", payload), created);
  await assert.rejects(
    request("create", { ...payload, lease: { ...lease, generation: 2 } }),
  );
  await request("quiesce", payload);
  const checkpoint = await request("capture", payload);
  assert.ok(
    checkpoint &&
      typeof checkpoint === "object" &&
      !Array.isArray(checkpoint) &&
      checkpoint.entries === 2,
  );
  const directory = await mkdtemp(join(tmpdir(), "jetski-ssh-retention-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  try {
    const store = new LocalCheckpointStore(join(directory, "objects"));
    const registry = new CheckpointRegistry(state, store);
    const fence = {
      owner: lease.owner,
      sandbox: lease.sandboxId,
      generation: lease.generation,
    };
    await registry.initialize(fence);
    const manifest = parseArchive(checkpoint);
    const saved = await new CheckpointTransfer(store, registry).save(
      fence,
      randomUUID(),
      manifest,
      {
        read: async (offset, bytes) => {
          const result = await request("read-checkpoint", {
            ...payload,
            offset,
            bytes,
          });
          if (
            !result ||
            typeof result !== "object" ||
            Array.isArray(result) ||
            typeof result.base64 !== "string"
          )
            throw new Error("Invalid transfer response");
          const decoded = Buffer.from(result.base64, "base64");
          assert.equal(
            createHash("sha256").update(decoded).digest("hex"),
            result.sha256,
          );
          return decoded;
        },
      },
    );
    const recovered: Uint8Array[] = [];
    for (const frame of saved.root.frames)
      for await (const part of store.read(frame)) recovered.push(part);
    assert.equal(
      createHash("sha256").update(Buffer.concat(recovered)).digest("hex"),
      manifest.sha256,
    );
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
  await request("remove", payload);
  console.log(
    JSON.stringify({
      sshControl: true,
      bootstrap: true,
      rootlessCreate: true,
      createReplay: true,
      staleFenceDenied: true,
      capture: true,
      verifiedLocalPublication: true,
    }),
  );
} finally {
  // Only the exact owned assignment. A failed state is preserved in CI logs.
  await request("quiesce", payload).catch(() => {});
  await request("remove", payload).catch(() => {});
}
