/** Real standalone API/SDK/CLI qualification on the disposable SSH CI host. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CheckpointRegistry } from "../src/core/checkpoints.js";
import type { Json } from "../src/core/contracts.js";
import { type Sandbox, SandboxManager } from "../src/core/manager.js";
import { parseArchive } from "../src/core/transfer.js";
import { SshHostProvider } from "../src/providers/ssh.js";
import { JetskiClient } from "../src/sdk.js";
import {
  bearerAuthentication,
  createHttpServer,
  startWorker,
} from "../src/server/http.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";
import { SshTransport } from "../src/transport/ssh.js";

const key = process.env.JETSKI_TEST_SSH_KEY,
  knownHosts = process.env.JETSKI_TEST_KNOWN_HOSTS,
  image = process.env.JETSKI_TEST_IMAGE;
if (!key || !knownHosts || !image) throw new Error("Missing CI configuration");
const directory = await mkdtemp(join(tmpdir(), "jetski-api-ci-"));
const state = new SqliteState(join(directory, "state.sqlite"));
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
const objects = new LocalCheckpointStore(join(directory, "objects"));
let controlUnavailable = false;
const manager = new SandboxManager(
  state,
  new SshHostProvider(["ssh-ci"], state, transport),
  {
    request: async (host, request) => {
      if (controlUnavailable) throw Error("Control transport unavailable");
      return transport.request(host, request);
    },
  },
  objects,
  { poolId: "ci", approvedImages: [image] },
);
const token = randomBytes(32).toString("hex"),
  foreignToken = randomBytes(32).toString("hex");
const server = createHttpServer(
  manager,
  bearerAuthentication([
    { owner: "qualification", token },
    { owner: "foreign", token: foreignToken },
  ]),
);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const url = `http://127.0.0.1:${address.port}`,
  client = new JetskiClient(url, token);
const errors: unknown[] = [];
const stopWorker = startWorker(manager, (error) => errors.push(error), 20);
let cleanupId: string;
const id = randomUUID(),
  operationId = randomUUID();
cleanupId = id;
try {
  await client.request("/v1/sandboxes", "POST", { id, operationId, image });
  let sandbox: Sandbox | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    sandbox = await client.request<Sandbox>(`/v1/sandboxes/${id}`);
    if (sandbox.phase === "running") break;
    if (sandbox.phase === "quarantined")
      throw new Error("Creation quarantined");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(sandbox?.phase, "running");
  assert.equal(errors.length, 0);
  assert.equal((await client.operation(id, operationId)).phase, "succeeded");
  await assert.rejects(
    new JetskiClient(url, foreignToken).request(`/v1/sandboxes/${id}`),
  );
  const commandId = randomUUID();
  const request = {
    id: commandId,
    argv: [
      "/bin/sh",
      "-ec",
      "printf 1 >> /workspace/api-counter; printf api-ok",
    ],
  };
  await client.request(`/v1/sandboxes/${id}/commands`, "POST", request);
  let command: Json = null;
  for (let attempt = 0; attempt < 100; attempt++) {
    command = await client.request<Json>(
      `/v1/sandboxes/${id}/commands/${commandId}`,
    );
    if (
      command &&
      typeof command === "object" &&
      !Array.isArray(command) &&
      command.phase === "succeeded"
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(
    command &&
      typeof command === "object" &&
      !Array.isArray(command) &&
      command.phase === "succeeded",
  );
  await client.request(`/v1/sandboxes/${id}/commands`, "POST", request);
  const output = await client.request<{ base64: string }>(
    `/v1/sandboxes/${id}/commands/${commandId}/output`,
  );
  assert.equal(Buffer.from(output.base64, "base64").toString(), "api-ok");
  await manager.retainCommand(
    { owner: "qualification", sandbox: id },
    commandId,
  );
  controlUnavailable = true;
  const retainedOutput = await client.request<{ base64: string }>(
    `/v1/sandboxes/${id}/commands/${commandId}/output`,
  );
  assert.equal(retainedOutput.base64, output.base64);
  assert.deepEqual(
    await client.request(`/v1/sandboxes/${id}/commands/${commandId}`),
    command,
  );
  const cli = await promisify(execFile)(
    process.execPath,
    ["dist/cli.js", "list"],
    { env: { ...process.env, JETSKI_URL: url, JETSKI_TOKEN: token } },
  );
  assert.equal((JSON.parse(cli.stdout) as Sandbox[])[0]?.id, id);
  controlUnavailable = false;
  const stopId = randomUUID();
  await client.request(`/v1/sandboxes/${id}/stop`, "POST", {
    operationId: stopId,
  });
  for (let attempt = 0; attempt < 150; attempt++) {
    const operation = await client.operation(id, stopId);
    if (operation.phase === "succeeded") break;
    if (operation.phase === "uncertain") throw Error("Stop uncertain");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await client.operation(id, stopId)).phase, "succeeded");
  const stopped = await client.request<Sandbox>(`/v1/sandboxes/${id}`);
  assert.equal(stopped.phase, "stopped");
  assert.equal(stopped.lease, null);
  controlUnavailable = true;
  assert.deepEqual(
    await client.request(`/v1/sandboxes/${id}/commands/${commandId}`),
    command,
  );
  assert.deepEqual(
    await client.request(`/v1/sandboxes/${id}/commands/${commandId}/output`),
    await manager.commandOutput(
      { owner: "qualification", sandbox: id },
      commandId,
      "stdout",
      0,
      256 * 1024,
    ),
  );
  controlUnavailable = false;
  const resumeId = randomUUID();
  await client.request(`/v1/sandboxes/${id}/resume`, "POST", {
    operationId: resumeId,
  });
  let replacement: Sandbox | undefined;
  for (let attempt = 0; attempt < 150; attempt++) {
    replacement = await client.request<Sandbox>(`/v1/sandboxes/${id}`);
    if (replacement.phase === "running") break;
    if (replacement.phase === "quarantined") throw Error("Resume quarantined");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(replacement?.phase, "running");
  assert.equal(replacement.lease?.machineId, sandbox?.lease?.machineId);
  assert.notEqual(
    replacement.lease?.assignmentId,
    sandbox?.lease?.assignmentId,
  );
  assert.equal(
    replacement.lease?.generation,
    (sandbox?.lease?.generation ?? 0) + 1,
  );
  assert.deepEqual(
    await client.request(`/v1/sandboxes/${id}/commands/${commandId}`),
    command,
  );
  const restoredCommand = randomUUID();
  await client.request(`/v1/sandboxes/${id}/commands`, "POST", {
    id: restoredCommand,
    argv: [
      "/bin/sh",
      "-ec",
      'test "$(cat /workspace/api-counter)" = 1; printf restored',
    ],
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await client.request<{ phase: string }>(
      `/v1/sandboxes/${id}/commands/${restoredCommand}`,
    );
    if (status.phase === "succeeded") break;
    if (status.phase === "failed")
      throw Error("Restored filesystem check failed");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(
    (
      await client.request<{ phase: string }>(
        `/v1/sandboxes/${id}/commands/${restoredCommand}`,
      )
    ).phase,
    "succeeded",
  );
  const secondStop = randomUUID();
  await client.request(`/v1/sandboxes/${id}/stop`, "POST", {
    operationId: secondStop,
  });
  for (let attempt = 0; attempt < 150; attempt++) {
    const operation = await client.operation(id, secondStop);
    if (operation.phase === "succeeded") break;
    if (operation.phase === "uncertain") throw Error("Repeated stop uncertain");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await client.operation(id, secondStop)).phase, "succeeded");
  const registry = new CheckpointRegistry(state, objects),
    fence = { owner: "qualification", sandbox: id, generation: 2 };
  const firstRoot = await registry.root(fence, stopId),
    secondRoot = await registry.root(fence, secondStop);
  assert.ok(firstRoot && secondRoot);
  assert.equal(
    parseArchive(firstRoot.metadata).sha256,
    parseArchive(secondRoot.metadata).sha256,
  );
  console.log(
    JSON.stringify({
      standaloneApi: true,
      ownerIsolation: true,
      serverProgress: true,
      commandExecution: true,
      outputWithoutHostControl: true,
      sdk: true,
      cli: true,
      durableStop: true,
      warmHostReuse: true,
      apiSourceDeletedRestore: true,
      repeatedCheckpointEqual: true,
      completeLifecycle: false,
    }),
  );
} finally {
  await stopWorker();
  let cleanupError: unknown;
  try {
    const sandbox = await manager.get({
      owner: "qualification",
      sandbox: cleanupId,
    });
    if (sandbox?.lease) {
      const payload = { lease: sandbox.lease, image };
      for (const action of ["quiesce", "remove"])
        await transport.request("ssh-ci", {
          version: 1,
          id: randomUUID(),
          action,
          payload,
        });
    }
  } catch (error) {
    cleanupError = error;
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  state.close();
  await rm(directory, { recursive: true, force: true });
  if (cleanupError) throw cleanupError;
}
