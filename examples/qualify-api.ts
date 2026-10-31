/** Real standalone API/SDK/CLI qualification on the disposable SSH CI host. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Json } from "../src/core/contracts.js";
import { type Sandbox, SandboxManager } from "../src/core/manager.js";
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
const manager = new SandboxManager(
  state,
  new SshHostProvider(["ssh-ci"], state, transport),
  transport,
  new LocalCheckpointStore(join(directory, "objects")),
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
const id = randomUUID(),
  operationId = randomUUID();
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
  const cli = await promisify(execFile)(
    process.execPath,
    ["dist/cli.js", "list"],
    { env: { ...process.env, JETSKI_URL: url, JETSKI_TOKEN: token } },
  );
  assert.equal((JSON.parse(cli.stdout) as Sandbox[])[0]?.id, id);
  console.log(
    JSON.stringify({
      standaloneApi: true,
      ownerIsolation: true,
      serverProgress: true,
      commandExecution: true,
      sdk: true,
      cli: true,
      completeLifecycle: false,
    }),
  );
} finally {
  await stopWorker();
  let cleanupError: unknown;
  try {
    const sandbox = await manager.get({ owner: "qualification", sandbox: id });
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
