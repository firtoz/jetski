/** Disposable-runner qualification; environment paths are ephemeral credentials. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  await request("remove", payload);
  console.log(
    JSON.stringify({
      sshControl: true,
      bootstrap: true,
      rootlessCreate: true,
      createReplay: true,
      staleFenceDenied: true,
      capture: true,
    }),
  );
} finally {
  // Only the exact owned assignment. A failed state is preserved in CI logs.
  await request("quiesce", payload).catch(() => {});
  await request("remove", payload).catch(() => {});
}
