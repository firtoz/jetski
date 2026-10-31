/** Real standalone API/SDK/CLI qualification on the disposable SSH CI host. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { CheckpointRegistry } from "../src/core/checkpoints.js";
import type { Json } from "../src/core/contracts.js";
import { DEFAULTS } from "../src/core/contracts.js";
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
let loseOutputAck = false,
  lostOutputAcks = 0;
let loseMultiOutputAck = false,
  lostMultiOutputAcks = 0,
  armCheckpointFault = false;
let loseSaveAck = false,
  lostSaveAcks = 0;
const objectPut = objects.put.bind(objects);
objects.put = async (...args) => {
  const committed = await objectPut(...args);
  if (loseMultiOutputAck) {
    loseMultiOutputAck = false;
    lostMultiOutputAcks++;
    throw Error("Injected multi-command output acknowledgement loss");
  }
  if (loseOutputAck) {
    loseOutputAck = false;
    lostOutputAcks++;
    throw Error("Injected output store acknowledgement loss");
  }
  if (loseSaveAck) {
    loseSaveAck = false;
    lostSaveAcks++;
    throw Error("Injected checkpoint store acknowledgement loss");
  }
  return committed;
};
let loseCancelAck = false,
  lostCancelAcks = 0;
let loseTerminalInputAck = true,
  lostTerminalInputAcks = 0;
let controlUnavailable = false;
let loseWriteAck = true;
let lostWriteAcks = 0;
let loseImportAck = true,
  lostImportAcks = 0;
let clockOffset = 0;
const manager = new SandboxManager(
  state,
  new SshHostProvider(["ssh-ci"], state, transport),
  {
    request: async (host, request) => {
      if (controlUnavailable) throw Error("Control transport unavailable");
      const response = await transport.request(host, request);
      if (request.action === "terminal-input" && loseTerminalInputAck) {
        loseTerminalInputAck = false;
        lostTerminalInputAcks++;
        throw Error("Injected terminal admission acknowledgement loss");
      }
      if (request.action === "read-checkpoint" && armCheckpointFault) {
        armCheckpointFault = false;
        loseSaveAck = true;
      }
      if (request.action === "file-write-finish" && loseWriteAck) {
        loseWriteAck = false;
        lostWriteAcks++;
        throw Error("Injected file publication acknowledgement loss");
      }
      if (request.action === "import-chunk" && loseImportAck) {
        loseImportAck = false;
        lostImportAcks++;
        throw Error("Injected import acknowledgement loss");
      }
      if (request.action === "command-cancel" && loseCancelAck) {
        loseCancelAck = false;
        lostCancelAcks++;
        throw Error("Injected cancellation acknowledgement loss");
      }
      return response;
    },
  },
  objects,
  {
    poolId: "ci",
    approvedImages: [image],
    now: () => Date.now() + clockOffset,
  },
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
  const cancelled = randomUUID(),
    cancelledCreate = randomUUID(),
    cancelledDelete = randomUUID();
  await client.request("/v1/sandboxes", "POST", {
    id: cancelled,
    operationId: cancelledCreate,
    image,
  });
  assert.equal(
    (await client.request<Sandbox>(`/v1/sandboxes/${cancelled}`)).phase,
    "queued",
  );
  await client.request(`/v1/sandboxes/${cancelled}`, "DELETE", {
    operationId: cancelledDelete,
  });
  assert.equal(
    (await client.operation(cancelled, cancelledCreate)).phase,
    "failed",
  );
  assert.equal(
    (await client.request<Sandbox>(`/v1/sandboxes/${cancelled}`)).phase,
    "deleted",
  );
  const uploadId = randomUUID();
  const uploadBytes = Buffer.from([0, 255, 1, 128]);
  const uploadSpec = {
    path: "/workspace/uploaded",
    bytes: uploadBytes.length,
    sha256: (await import("node:crypto"))
      .createHash("sha256")
      .update(uploadBytes)
      .digest("hex"),
    mode: 0o640,
  };
  await client
    .writeFileStream(
      id,
      uploadId,
      uploadSpec,
      (async function* () {
        yield uploadBytes.subarray(0, 2);
        yield uploadBytes.subarray(2);
      })(),
    )
    .catch(() => undefined);
  assert.equal(lostWriteAcks, 1);
  const partialId = randomUUID();
  await client.beginUpload(id, partialId, {
    ...uploadSpec,
    path: "/workspace/incomplete",
  });
  const victim = randomUUID(),
    survivor = randomUUID();
  const status = async (command: string) =>
    client.request<{ phase: string }>(
      `/v1/sandboxes/${id}/commands/${command}`,
    );
  const waitPhase = async (command: string, phase: string) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      const observed = await status(command);
      if (observed.phase === phase) return;
      if (
        ["failed", "uncertain", "cancelled", "succeeded"].includes(
          observed.phase,
        )
      )
        assert.equal(observed.phase, phase, JSON.stringify(observed));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal((await status(command)).phase, phase);
  };
  await client.request(`/v1/sandboxes/${id}/commands`, "POST", {
    id: victim,
    argv: [
      "/bin/sh",
      "-ec",
      "sleep 120 & echo $! > /workspace/cancel-child; printf ready; wait",
    ],
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    const out = await client.request<{ base64: string }>(
      `/v1/sandboxes/${id}/commands/${victim}/output`,
    );
    if (Buffer.from(out.base64, "base64").toString() === "ready") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const ready = await client.request<{ base64: string }>(
    `/v1/sandboxes/${id}/commands/${victim}/output`,
  );
  assert.equal(Buffer.from(ready.base64, "base64").toString(), "ready");
  await client.request(`/v1/sandboxes/${id}/commands`, "POST", {
    id: survivor,
    argv: ["/bin/sh", "-ec", "sleep 3; printf survived"],
  });
  await assert.rejects(
    new JetskiClient(url, foreignToken).cancelCommand(id, victim),
  );
  loseCancelAck = true;
  await client.cancelCommand(id, victim).catch(() => undefined);
  await waitPhase(victim, "cancelled");
  assert.equal(lostCancelAcks, 1);
  assert.equal(
    ((await client.cancelCommand(id, victim)) as { phase: string }).phase,
    "cancelled",
  );
  await waitPhase(survivor, "succeeded");
  const cleanupCheck = randomUUID();
  await client.request(`/v1/sandboxes/${id}/commands`, "POST", {
    id: cleanupCheck,
    argv: [
      "/bin/sh",
      "-ec",
      "test ! -e /proc/$(cat /workspace/cancel-child); rm /workspace/cancel-child",
    ],
  });
  await waitPhase(cleanupCheck, "succeeded");
  assert.equal(
    (await client.request<Sandbox>(`/v1/sandboxes/${id}`)).phase,
    "running",
  );
  const terminalId = randomUUID(),
    terminalFirst = randomUUID(),
    terminalSecond = randomUUID();
  const terminalArgv = [
    "/bin/sh",
    "-ec",
    'test -t 0; test "$(stty size)" = "37 101"; stty -echo; printf READY; IFS= read -r first; printf "FIRST:%s\\n" "$first"; IFS= read -r second; test "$second" = second; printf TERMINAL-DONE',
  ];
  await client.startTerminal(id, terminalId, terminalArgv, "/workspace", 120, {
    rows: 37,
    columns: 101,
  });
  await assert.rejects(
    client.startTerminal(id, terminalId, terminalArgv, "/workspace", 120, {
      rows: 38,
      columns: 101,
    }),
  );
  const waitTerminalText = async (marker: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const output = await client.terminalOutput(id, terminalId);
      const text = Buffer.from(output.base64, "base64").toString();
      if (text.includes(marker)) return text;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Error("API terminal output deadline");
  };
  await waitTerminalText("READY");
  const firstInput = {
    kind: "stdin" as const,
    base64: Buffer.from("first\n").toString("base64"),
  };
  await client
    .terminalInput(id, terminalId, terminalFirst, firstInput)
    .catch(() => undefined);
  await waitTerminalText("FIRST:first");
  assert.equal(lostTerminalInputAcks, 1);
  await client.terminalInput(id, terminalId, terminalFirst, firstInput);
  await assert.rejects(
    new JetskiClient(url, foreignToken).terminalInput(
      id,
      terminalId,
      randomUUID(),
      firstInput,
    ),
  );
  await client.terminalInput(id, terminalId, terminalSecond, {
    kind: "stdin",
    base64: Buffer.from("second\n").toString("base64"),
  });
  const terminalText = await waitTerminalText("TERMINAL-DONE");
  assert.equal(terminalText.split("FIRST:first").length, 2);
  await waitPhase(terminalId, "succeeded");
  const terminalOutcomes: Json[] = [];
  for (const inputId of [terminalFirst, terminalSecond]) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const outcome = (await client.terminalInputStatus(
        id,
        terminalId,
        inputId,
      )) as { phase: string };
      if (outcome.phase === "sent") {
        terminalOutcomes.push(outcome);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.equal(terminalOutcomes.length, 2);
  const pressureTerminal = randomUUID();
  await client.startTerminal(id, pressureTerminal, [
    "/bin/sh",
    "-ec",
    "stty raw -echo; printf PRESSURE-READY; sleep 120 & wait",
  ]);
  let pressureReady = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const output = await client.terminalOutput(id, pressureTerminal);
    if (
      Buffer.from(output.base64, "base64").toString().includes("PRESSURE-READY")
    ) {
      pressureReady = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(pressureReady, true);
  const pressureIds: string[] = [];
  const pressureInput = {
    kind: "stdin" as const,
    base64: Buffer.alloc(16384).toString("base64"),
  };
  // Each identity is admitted at most once here. A failed response is observed,
  // never replaced with a new identity or blindly resent.
  for (let attempt = 0; attempt < 128; attempt++) {
    const inputId = randomUUID();
    pressureIds.push(inputId);
    try {
      const receipt = (await client.terminalInput(
        id,
        pressureTerminal,
        inputId,
        pressureInput,
      )) as { phase: string };
      if (["uncertain", "cancelled"].includes(receipt.phase)) break;
    } catch {
      break;
    }
  }
  await waitPhase(pressureTerminal, "failed");
  const pressureStatus = (await client.terminalStatus(
    id,
    pressureTerminal,
  )) as { phase: string; reason: string; exitCode: number };
  assert.equal(pressureStatus.reason, "terminal_input_uncertain");
  assert.equal(pressureStatus.exitCode, 143);
  const pressureOutcomes = new Map<string, Json>();
  const pressureDeadline = Date.now() + 60000;
  while (pressureOutcomes.size < pressureIds.length) {
    for (const inputId of pressureIds) {
      if (pressureOutcomes.has(inputId)) continue;
      const receipt = (await client.terminalInputStatus(
        id,
        pressureTerminal,
        inputId,
      )) as { phase: string } & Json;
      if (["sent", "uncertain", "cancelled"].includes(receipt.phase))
        pressureOutcomes.set(inputId, receipt);
    }
    assert.ok(
      Date.now() < pressureDeadline,
      "Pressure receipts did not settle",
    );
    if (pressureOutcomes.size < pressureIds.length)
      await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const uncertainInputs = [...pressureOutcomes].filter(
    ([, receipt]) => (receipt as { phase: string }).phase === "uncertain",
  );
  assert.equal(uncertainInputs.length, 1);
  assert.ok(
    [...pressureOutcomes.values()].some(
      (receipt) => (receipt as { phase: string }).phase === "sent",
    ),
  );
  const [uncertainId, uncertainOutcome] = uncertainInputs[0]!;
  assert.deepEqual(
    await client.terminalInput(
      id,
      pressureTerminal,
      uncertainId,
      pressureInput,
    ),
    uncertainOutcome,
  );
  assert.deepEqual(
    await client.terminalStatus(id, pressureTerminal),
    pressureStatus,
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
  const fileParts: Uint8Array[] = [];
  for await (const part of client.readFileStream(id, "/workspace/api-counter"))
    fileParts.push(part);
  assert.equal(Buffer.concat(fileParts).toString(), "1");
  const files = await client.listFiles(id, "/workspace");
  assert.ok(
    files.entries.some(
      (entry) => entry.name === "api-counter" && entry.kind === "file",
    ),
  );
  await assert.rejects(
    new JetskiClient(url, foreignToken).readFile(id, "/workspace/api-counter"),
  );
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
  assert.equal(
    (JSON.parse(cli.stdout) as Sandbox[]).find((item) => item.id === id)?.id,
    id,
  );
  controlUnavailable = false;
  const cliRead = await promisify(execFile)(
    process.execPath,
    ["dist/cli.js", "file-read", id, "/workspace/api-counter"],
    { env: { ...process.env, JETSKI_URL: url, JETSKI_TOKEN: token } },
  );
  assert.equal(cliRead.stdout, "1");
  // Target two distinct publication boundaries: an output object first, then
  // the filesystem archive only after its source read begins.
  loseMultiOutputAck = true;
  armCheckpointFault = true;
  const firstStopStarted = Date.now();
  const firstStopErrors = errors.length;
  const stopId = randomUUID();
  await client.request(`/v1/sandboxes/${id}/stop`, "POST", {
    operationId: stopId,
  });
  for (let attempt = 0; attempt < 600; attempt++) {
    const operation = await client.operation(id, stopId);
    if (operation.phase === "succeeded") break;
    // Publication recovery must reuse the committed frame after lost store ACK.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(
    (await client.operation(id, stopId)).phase,
    "succeeded",
    JSON.stringify({
      errors: errors
        .slice(-5)
        .map((error) =>
          error instanceof Error ? error.message : String(error),
        ),
      operation: await client.operation(id, stopId),
    }),
  );
  const stopRecoveryErrors = errors
    .slice(firstStopErrors)
    .map((error) => (error instanceof Error ? error.message : String(error)));
  assert.deepEqual(stopRecoveryErrors, [
    "Injected multi-command output acknowledgement loss",
    "Injected checkpoint store acknowledgement loss",
  ]);
  assert.equal(lostMultiOutputAcks, 1);
  console.log(
    JSON.stringify({
      multiOutputStopMs: Date.now() - firstStopStarted,
      recoveredUploadAcknowledgementLoss: true,
    }),
  );
  assert.equal((await client.operation(id, uploadId)).phase, "succeeded");
  assert.equal((await client.operation(id, partialId)).phase, "failed");
  assert.equal((await client.uploadStatus(id, uploadId)).phase, "committed");
  assert.equal(lostWriteAcks, 1);
  assert.equal(lostSaveAcks, 1);
  const stopped = await client.request<Sandbox>(`/v1/sandboxes/${id}`);
  assert.equal(stopped.phase, "stopped");
  assert.equal(stopped.lease, null);
  assert.ok(stopped.checkpoint);
  const historyPage = await client.checkpoints(id);
  assert.ok(
    historyPage.checkpoints.some((item) => item.id === stopped.checkpoint),
  );
  const pinId = randomUUID();
  await client.pinCheckpoint(
    id,
    stopped.checkpoint,
    "qualification",
    true,
    pinId,
  );
  assert.deepEqual((await client.checkpoint(id, stopped.checkpoint)).pins, [
    "qualification",
  ]);
  await assert.rejects(
    new JetskiClient(url, foreignToken).checkpoint(id, stopped.checkpoint),
  );
  controlUnavailable = true;
  for (const [inputId, receipt] of pressureOutcomes)
    assert.deepEqual(
      await client.terminalInputStatus(id, pressureTerminal, inputId),
      receipt,
    );
  assert.deepEqual(
    await client.terminalInput(
      id,
      pressureTerminal,
      uncertainId,
      pressureInput,
    ),
    uncertainOutcome,
  );
  assert.deepEqual(
    await client.terminalStatus(id, pressureTerminal),
    pressureStatus,
  );
  const terminalCli = await promisify(execFile)(
    process.execPath,
    [
      "dist/cli.js",
      "terminal-input-status",
      id,
      terminalId,
      "--id",
      terminalFirst,
    ],
    { env: { ...process.env, JETSKI_URL: url, JETSKI_TOKEN: token } },
  );
  assert.deepEqual(JSON.parse(terminalCli.stdout), terminalOutcomes[0]);
  assert.deepEqual(
    await client.terminalInputStatus(id, terminalId, terminalFirst),
    terminalOutcomes[0],
  );
  assert.deepEqual(
    await client.terminalInputStatus(id, terminalId, terminalSecond),
    terminalOutcomes[1],
  );
  assert.equal(
    Buffer.from(
      (await client.terminalOutput(id, terminalId)).base64,
      "base64",
    ).toString(),
    terminalText,
  );

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
    // The injected lost import acknowledgement temporarily quarantines this
    // assignment; server reconciliation must observe and recover it.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(replacement?.phase, "running");
  await client.pinCheckpoint(
    id,
    stopped.checkpoint,
    "qualification",
    false,
    randomUUID(),
  );
  await client.pinCheckpoint(
    id,
    stopped.checkpoint,
    "qualification",
    true,
    pinId,
  );
  assert.deepEqual((await client.checkpoint(id, stopped.checkpoint)).pins, []);
  const restoredUpload: Uint8Array[] = [];
  for await (const part of client.readFileStream(id, uploadSpec.path))
    restoredUpload.push(part);
  assert.deepEqual(Buffer.concat(restoredUpload), uploadBytes);
  assert.equal(
    (
      await client.writeFileStream(
        id,
        uploadId,
        uploadSpec,
        (async function* () {
          throw Error("Completed upload must not consume a new source");
          yield new Uint8Array();
        })(),
      )
    ).phase,
    "committed",
  );
  assert.equal(lostImportAcks, 1);
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
  loseOutputAck = true;
  const secondStop = randomUUID();
  await client.request(`/v1/sandboxes/${id}/checkpoint`, "POST", {
    operationId: secondStop,
  });
  for (let attempt = 0; attempt < 150; attempt++) {
    const operation = await client.operation(id, secondStop);
    if (operation.phase === "succeeded") break;
    // The worker must recover output retention before publishing the checkpoint.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await client.operation(id, secondStop)).phase, "succeeded");
  assert.equal(lostOutputAcks, 1);
  const registry = new CheckpointRegistry(state, objects),
    fence = { owner: "qualification", sandbox: id, generation: 2 };
  const firstRoot = await registry.root(fence, stopId),
    secondRoot = await registry.root(fence, secondStop);
  assert.ok(firstRoot && secondRoot);
  assert.equal(
    parseArchive(firstRoot.metadata).sha256,
    parseArchive(secondRoot.metadata).sha256,
  );
  const held = await client.request<Sandbox>(`/v1/sandboxes/${id}`);
  assert.ok(held.lease);
  const heldResume = randomUUID();
  await client.request(`/v1/sandboxes/${id}/resume`, "POST", {
    operationId: heldResume,
  });
  for (let attempt = 0; attempt < 200; attempt++) {
    const operation = await client.operation(id, heldResume);
    if (operation.phase === "succeeded") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await client.operation(id, heldResume)).phase, "succeeded");
  const resumedHeld = await client.request<Sandbox>(`/v1/sandboxes/${id}`);
  assert.equal(resumedHeld.phase, "running");
  assert.equal(resumedHeld.generation, 3);
  assert.notEqual(resumedHeld.lease?.assignmentId, held.lease.assignmentId);
  assert.equal(resumedHeld.lease?.machineId, held.lease.machineId);
  await client.request(`/v1/sandboxes/${id}/resume`, "POST", {
    operationId: heldResume,
  });
  assert.equal(
    (await client.request<Sandbox>(`/v1/sandboxes/${id}`)).lease?.assignmentId,
    resumedHeld.lease?.assignmentId,
  );
  const changed = Buffer.from("2");
  await client.writeFileStream(
    id,
    randomUUID(),
    {
      path: "/workspace/api-counter",
      bytes: 1,
      sha256: (await import("node:crypto"))
        .createHash("sha256")
        .update(changed)
        .digest("hex"),
      mode: 0o644,
    },
    (async function* () {
      yield changed;
    })(),
  );
  const newerStop = randomUUID();
  await client.request(`/v1/sandboxes/${id}/stop`, "POST", {
    operationId: newerStop,
  });
  for (let attempt = 0; attempt < 150; attempt++) {
    if ((await client.operation(id, newerStop)).phase === "succeeded") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await client.operation(id, newerStop)).phase, "succeeded");
  assert.notEqual(
    (await client.checkpoint(id, newerStop)).sha256,
    (await client.checkpoint(id, stopId)).sha256,
  );
  const historicalResume = randomUUID();
  await client.resume(id, historicalResume, stopId);
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await client.operation(id, historicalResume)).phase === "succeeded")
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(
    (await client.operation(id, historicalResume)).phase,
    "succeeded",
  );
  assert.equal(
    Buffer.from(
      (await client.readFile(id, "/workspace/api-counter")).base64,
      "base64",
    ).toString(),
    "1",
  );
  await assert.rejects(client.resume(id, historicalResume, newerStop));
  assert.equal(
    (
      await state.transaction((tx) =>
        tx.scan(`checkpoint-reference/qualification/${id}/`),
      )
    ).length,
    0,
  );
  assert.ok(await client.checkpoint(id, newerStop));
  fence.generation = 4;
  const deletion = randomUUID();
  await client.request(`/v1/sandboxes/${id}`, "DELETE", {
    operationId: deletion,
  });
  for (let attempt = 0; attempt < 150; attempt++) {
    const operation = await client.operation(id, deletion);
    if (operation.phase === "succeeded") break;
    if (operation.phase === "uncertain")
      throw Error("Assigned deletion uncertain");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await client.operation(id, deletion)).phase, "succeeded");
  const finalRoot = await registry.root(fence, deletion);
  assert.ok(finalRoot);
  assert.equal(
    parseArchive(finalRoot.metadata).sha256,
    parseArchive(firstRoot.metadata).sha256,
  );
  assert.equal(
    (await client.request<Sandbox>(`/v1/sandboxes/${id}`)).phase,
    "deleted",
  );
  assert.deepEqual(
    await client.request(`/v1/sandboxes/${id}/commands/${commandId}`),
    command,
  );
  await assert.rejects(
    client.request(`/v1/sandboxes/${id}/resume`, "POST", {
      operationId: randomUUID(),
    }),
  );
  await client.request(`/v1/sandboxes/${id}`, "DELETE", {
    operationId: deletion,
  });
  assert.ok(await registry.root(fence, secondStop));
  // Advance only this controller's injected clock; no provider clocks or GC
  // grace periods are modified. SSH retirement must leave the machine alive.
  clockOffset = DEFAULTS.idleMs;
  await manager.reconcile("qualification");
  for (let attempt = 0; attempt < 50; attempt++) {
    const allocation = await state.transaction((tx) =>
      tx.get<{ allocated: boolean }>("ssh-host/ssh-ci"),
    );
    if (allocation?.allocated === false) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(
    (
      await state.transaction((tx) =>
        tx.get<{ allocated: boolean }>("ssh-host/ssh-ci"),
      )
    )?.allocated,
    false,
  );
  const hostStatus = await transport.request("ssh-ci", {
    version: 1,
    id: randomUUID(),
    action: "status",
    payload: null,
  });
  assert.ok(
    hostStatus.result &&
      typeof hostStatus.result === "object" &&
      !Array.isArray(hostStatus.result) &&
      hostStatus.result.ready === true,
  );
  const expiring = randomUUID();
  cleanupId = expiring;
  await client.request("/v1/sandboxes", "POST", {
    id: expiring,
    operationId: randomUUID(),
    image,
  });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (
      (await client.request<Sandbox>(`/v1/sandboxes/${expiring}`)).phase ===
      "running"
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(
    (await client.request<Sandbox>(`/v1/sandboxes/${expiring}`)).phase,
    "running",
  );
  const expiryCommand = randomUUID();
  await client.request(`/v1/sandboxes/${expiring}/commands`, "POST", {
    id: expiryCommand,
    argv: [
      "/bin/sh",
      "-ec",
      "printf expiry-fixture-bytes > /workspace/expiry-data",
    ],
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      (
        await client.request<{ phase: string }>(
          `/v1/sandboxes/${expiring}/commands/${expiryCommand}`,
        )
      ).phase === "succeeded"
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(
    (
      await client.request<{ phase: string }>(
        `/v1/sandboxes/${expiring}/commands/${expiryCommand}`,
      )
    ).phase,
    "succeeded",
  );
  clockOffset += DEFAULTS.hostLifetimeMs - DEFAULTS.hostDrainMs;
  let drained: Sandbox | undefined;
  for (let attempt = 0; attempt < 200; attempt++) {
    drained = await client.request<Sandbox>(`/v1/sandboxes/${expiring}`);
    if (drained.phase === "stopped") break;
    if (drained.phase === "quarantined")
      throw Error("Expiry drain quarantined");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(drained?.phase, "stopped");
  assert.equal(drained.lease, null);
  assert.ok(drained.checkpoint);
  const expiryRoot = await registry.root(
    { owner: "qualification", sandbox: expiring, generation: 1 },
    drained.checkpoint,
  );
  assert.ok(expiryRoot);
  const archiveParts: Uint8Array[] = [];
  for (const frame of expiryRoot.frames)
    for await (const part of objects.read(frame)) archiveParts.push(part);
  assert.ok(
    gunzipSync(Buffer.concat(archiveParts)).includes(
      Buffer.from("expiry-fixture-bytes"),
    ),
  );
  console.log(
    JSON.stringify({
      standaloneApi: true,
      apiTerminalInputReplay: true,
      terminalOutcomesWithoutHost: true,
      apiTerminalPressureUncertaintyRetained: true,
      pressureInputIdentities: pressureIds.length,
      ownerIsolation: true,
      serverProgress: true,
      commandExecution: true,
      independentCommandCancellation: true,
      lostCancellationAcknowledgementRecovery: true,
      outputWithoutHostControl: true,
      sdk: true,
      cli: true,
      durableStop: true,
      warmHostReuse: true,
      apiSourceDeletedRestore: true,
      repeatedCheckpointEqual: true,
      idleRetirementWithoutPowerOff: true,
      deletedSandboxRetainsHistory: true,
      heldCheckpointResume: true,
      lostImportAcknowledgementRecovery: true,
      lostCheckpointStoreAcknowledgementRecovery: true,
      lostOutputStoreAcknowledgementRecovery: true,
      multiCommandOutputAcknowledgementRecovery: true,
      assignedDeletion: true,
      queuedDeletion: true,
      proactiveExpiryCheckpoint: true,
      boundedFileReadAndList: true,
      lostFileWriteAckRecovery: true,
      incompleteUploadAbortedOnStop: true,
      checkpointHistoryAndReplaySafePins: true,
      historicalCheckpointSelection: true,
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
