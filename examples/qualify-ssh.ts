/** Disposable-runner qualification; environment paths are ephemeral credentials. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  CheckpointRegistry,
  CheckpointTransfer,
  parseArchive,
} from "../src/core/index.js";
import { SqliteState } from "../src/state/sqlite.js";
import { LocalCheckpointStore } from "../src/storage/local.js";
import { SshTransport } from "../src/transport/ssh.js";
import { qualifyHostStream } from "./qualify-host-stream.js";

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
let activePayload = payload;
await request("claim", { lease });
try {
  const created = await request("create", payload);
  assert.deepEqual(await request("create", payload), created);
  await assert.rejects(
    request("create", { ...payload, lease: { ...lease, generation: 2 } }),
  );
  const reservedStream = randomUUID();
  const reservation = await request("stream-reserve", {
    ...payload,
    streamId: reservedStream,
    port: 8080,
  });
  assert.deepEqual(
    await request("stream-reserve", {
      ...payload,
      streamId: reservedStream,
      port: 8080,
    }),
    reservation,
  );
  await assert.rejects(
    request("stream-reserve", {
      ...payload,
      streamId: reservedStream,
      port: 8081,
    }),
  );
  const blockedStream = randomUUID();
  const tombstone = await request("stream-cancel", {
    ...payload,
    streamId: blockedStream,
  });
  assert.deepEqual(
    await request("stream-reserve", {
      ...payload,
      streamId: blockedStream,
      port: 8080,
    }),
    tombstone,
  );
  assert.equal((tombstone as { phase: string }).phase, "cancelled");
  const waitCommand = async (commandId: string, commandPayload = payload) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await request("command-status", {
        ...commandPayload,
        commandId,
      });
      if (
        result &&
        typeof result === "object" &&
        !Array.isArray(result) &&
        ["succeeded", "failed", "cancelled", "uncertain"].includes(
          String(result.phase),
        )
      )
        return result;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Command did not reach a terminal receipt");
  };
  await qualifyHostStream(
    {
      id: "ssh-ci",
      hostname: "127.0.0.1",
      port: 2222,
      user: "root",
      privateKeyPath: key,
      knownHostsPath: knownHosts,
    },
    payload,
    request,
  );
  const uploadId = randomUUID();
  const uploadBytes = Buffer.alloc(300000);
  for (let index = 0; index < uploadBytes.length; index++)
    uploadBytes[index] = index % 256;
  await request("file-write-begin", {
    ...payload,
    uploadId,
    path: "/workspace/payload",
    bytes: uploadBytes.length,
    sha256: createHash("sha256").update(uploadBytes).digest("hex"),
    mode: 0o640,
  });
  for (let offset = 0; offset < uploadBytes.length; offset += 262144) {
    const part = uploadBytes.subarray(offset, offset + 262144);
    const chunk = {
      ...payload,
      uploadId,
      offset,
      base64: part.toString("base64"),
      sha256: createHash("sha256").update(part).digest("hex"),
    };
    const receipt = await request("file-write-chunk", chunk);
    assert.deepEqual(await request("file-write-chunk", chunk), receipt);
  }
  const publishedWrite = await request("file-write-finish", {
    ...payload,
    uploadId,
  });
  assert.ok(
    publishedWrite &&
      typeof publishedWrite === "object" &&
      !Array.isArray(publishedWrite) &&
      publishedWrite.phase === "committed",
  );
  const readParts: Buffer[] = [];
  for (let offset = 0; offset < uploadBytes.length; offset += 262144) {
    const read = await request("file-read", {
      ...payload,
      path: "/workspace/payload",
      offset,
      bytes: 262144,
    });
    assert.ok(
      read &&
        typeof read === "object" &&
        !Array.isArray(read) &&
        typeof read.base64 === "string",
    );
    readParts.push(Buffer.from(read.base64, "base64"));
  }
  assert.deepEqual(Buffer.concat(readParts), uploadBytes);
  const commandId = randomUUID();
  const argv = [
    "/bin/sh",
    "-ec",
    "printf 1 >> /workspace/counter; printf 'hello\\000world' > /workspace/payload; chmod 640 /workspace/payload; ln /workspace/payload /workspace/hard; ln -s /workspace/payload /home/sandbox/link; cat /workspace/payload",
  ];
  await request("command-start", { ...payload, commandId, argv });
  const firstCommand = await waitCommand(commandId);
  assert.equal(firstCommand.phase, "succeeded", JSON.stringify(firstCommand));
  const snapshot = firstCommand.outputSnapshot as {
    version: number;
    channels: {
      stdout: { base64: string; sha256: string };
      stderr: { base64: string; sha256: string };
    };
  };
  assert.equal(snapshot.version, 1);
  const observedOutput = Buffer.from("hello\0world");
  assert.deepEqual(
    Buffer.from(snapshot.channels.stdout.base64, "base64"),
    observedOutput,
  );
  assert.equal(
    snapshot.channels.stdout.sha256,
    createHash("sha256").update(observedOutput).digest("hex"),
  );
  const observedStderr = Buffer.from(snapshot.channels.stderr.base64, "base64");
  assert.equal(
    snapshot.channels.stderr.sha256,
    createHash("sha256").update(observedStderr).digest("hex"),
  );

  // An acknowledged upload replay observes history, never overwrites newer workload bytes.
  assert.deepEqual(
    await request("file-write-finish", { ...payload, uploadId }),
    publishedWrite,
  );
  const afterReplay = await request("file-read", {
    ...payload,
    path: "/workspace/payload",
    offset: 0,
    bytes: 262144,
  });
  assert.ok(
    afterReplay &&
      typeof afterReplay === "object" &&
      !Array.isArray(afterReplay) &&
      typeof afterReplay.base64 === "string",
  );
  assert.deepEqual(
    Buffer.from(afterReplay.base64, "base64"),
    Buffer.from("hello\0world"),
  );
  const replay = await request("command-start", {
    ...payload,
    commandId,
    argv,
  });
  assert.ok(
    replay &&
      typeof replay === "object" &&
      !Array.isArray(replay) &&
      replay.phase === "succeeded",
  );
  const first = await request("command-output", {
    ...payload,
    commandId,
    channel: "stdout",
    offset: 0,
    bytes: 4,
  });
  const second = await request("command-output", {
    ...payload,
    commandId,
    channel: "stdout",
    offset: 4,
    bytes: 256,
  });
  if (
    !first ||
    !second ||
    typeof first !== "object" ||
    typeof second !== "object" ||
    Array.isArray(first) ||
    Array.isArray(second) ||
    typeof first.base64 !== "string" ||
    typeof second.base64 !== "string"
  )
    throw new Error("Invalid output receipt");
  assert.deepEqual(
    Buffer.concat([
      Buffer.from(first.base64, "base64"),
      Buffer.from(second.base64, "base64"),
    ]),
    Buffer.from("hello\0world"),
  );
  const verifyId = randomUUID();
  await request("command-start", {
    ...payload,
    commandId: verifyId,
    argv: ["/bin/sh", "-ec", 'test "$(cat /workspace/counter)" = 1'],
  });
  assert.equal((await waitCommand(verifyId)).phase, "succeeded");
  const terminalId = randomUUID();
  await request("terminal-start", {
    ...payload,
    commandId: terminalId,
    rows: 33,
    columns: 97,
    argv: [
      "/bin/sh",
      "-ec",
      'test "$(stty size)" = "33 97"; stty -echo; printf TERMINAL-READY; IFS= read -r first; printf "FIRST:%s\\n" "$first"; stty size; IFS= read -r second; test "$second" = second; trap "printf INTERRUPTED; exit 0" INT; printf SIGNAL-READY; while :; do sleep 1; done',
    ],
  });
  const terminalOutput = async (marker: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const output = (await request("command-output", {
        ...payload,
        commandId: terminalId,
        channel: "stdout",
        offset: 0,
        bytes: 262144,
      })) as { base64: string };
      const text = Buffer.from(output.base64, "base64").toString();
      if (text.includes(marker)) return text;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Error("Terminal output deadline");
  };
  const terminalInput = async (
    inputId: string,
    input: import("../src/core/contracts.js").Json,
  ) =>
    request("terminal-input", {
      ...payload,
      commandId: terminalId,
      inputId,
      input,
    });
  await terminalOutput("TERMINAL-READY");
  await terminalInput(randomUUID(), { kind: "resize", rows: 40, columns: 100 });
  const firstInput = randomUUID(),
    firstBytes = {
      kind: "stdin",
      base64: Buffer.from("first\n").toString("base64"),
    };
  await assert.rejects(
    (async () => {
      await terminalInput(firstInput, firstBytes);
      throw Error("Injected input admission ACK loss");
    })(),
    /admission ACK loss/,
  );
  await terminalOutput("FIRST:first");
  await terminalInput(firstInput, firstBytes);
  const receipt = (await request("terminal-input-status", {
    ...payload,
    commandId: terminalId,
    inputId: firstInput,
  })) as { phase: string };
  assert.equal(receipt.phase, "sent");
  await assert.rejects(
    request("terminal-input", {
      ...payload,
      lease: { ...lease, owner: "foreign" },
      commandId: terminalId,
      inputId: randomUUID(),
      input: firstBytes,
    }),
  );
  await assert.rejects(terminalInput(firstInput, { kind: "close" }));
  await terminalInput(randomUUID(), {
    kind: "stdin",
    base64: Buffer.from("second\n").toString("base64"),
  });
  const terminalText = await terminalOutput("SIGNAL-READY");
  assert.ok(terminalText.includes("40 100\r\n"));
  assert.equal(terminalText.split("FIRST:first").length, 2);
  await terminalInput(randomUUID(), { kind: "signal", signal: "INT" });
  assert.equal((await waitCommand(terminalId)).phase, "succeeded");
  assert.ok((await terminalOutput("INTERRUPTED")).endsWith("INTERRUPTED"));
  const closingTerminal = randomUUID();
  await request("terminal-start", {
    ...payload,
    commandId: closingTerminal,
    argv: ["/bin/sh", "-c", "sleep 120"],
  });
  await request("terminal-input", {
    ...payload,
    commandId: closingTerminal,
    inputId: randomUUID(),
    input: { kind: "close" },
  });
  assert.equal((await waitCommand(closingTerminal)).phase, "cancelled");
  const cancelId = randomUUID();
  await request("command-start", {
    ...payload,
    commandId: cancelId,
    argv: ["/bin/sh", "-c", "sleep 30"],
  });
  await request("command-cancel", { ...payload, commandId: cancelId });
  assert.equal((await waitCommand(cancelId)).phase, "cancelled");
  await request("quiesce", payload);
  const stoppedStream = await request("stream-status", {
    ...payload,
    streamId: reservedStream,
  });
  assert.equal((stoppedStream as { phase: string }).phase, "cancelled");
  assert.equal((stoppedStream as { delivery: string }).delivery, "unknown");
  assert.equal((stoppedStream as { reason: string }).reason, "runtime_stopped");
  const checkpoint = await request("capture", payload);
  assert.ok(
    checkpoint &&
      typeof checkpoint === "object" &&
      !Array.isArray(checkpoint) &&
      checkpoint.entries === 6,
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
    await request("remove", payload);
    const publication = {
      checkpointId: saved.root.id,
      sha256: manifest.sha256,
    };
    await request("release", { ...payload, publication });
    assert.deepEqual(await request("purge-source", payload), { purged: true });
    activePayload = {
      lease: { ...lease, assignmentId: randomUUID(), generation: 2 },
      image,
    };
    await request("claim", { lease: activePayload.lease });
    const cachedImport = (await request("import-begin", {
      ...activePayload,
      ...publication,
      bytes: manifest.bytes,
    })) as { phase: string; offset: number };
    assert.equal(cachedImport.phase, "ready");
    assert.equal(cachedImport.offset, manifest.bytes);
    // No store reads or import-chunk calls: published local archive survives
    // source-tree purge. Begin completes verification/extraction before ready;
    // no extra finish RPC is needed for this installed host bundle.
    await request("create", activePayload);
    const recoveredCommand = randomUUID();
    await request("command-start", {
      ...activePayload,
      commandId: recoveredCommand,
      argv: [
        "/bin/sh",
        "-ec",
        'test "$(cat /workspace/counter)" = 1; test "$(stat -c %a /workspace/payload)" = 640; test "$(stat -c %i /workspace/hard)" = "$(stat -c %i /workspace/payload)"; test "$(readlink /home/sandbox/link)" = /workspace/payload; test "$(wc -c < /workspace/payload)" = 11',
      ],
    });
    assert.equal(
      (await waitCommand(recoveredCommand, activePayload)).phase,
      "succeeded",
    );
    await request("quiesce", activePayload);
    const restoredCheckpoint = parseArchive(
      await request("capture", activePayload),
    );
    assert.equal(restoredCheckpoint.sha256, manifest.sha256);
    await request("remove", activePayload);
    await request("release", { ...activePayload, publication });
    await request("purge-source", activePayload);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
  // Destructive worker-loss injection only on this disposable, owned CI host.
  activePayload = {
    lease: { ...lease, assignmentId: randomUUID(), generation: 3 },
    image,
  };
  await request("claim", { lease: activePayload.lease });
  await request("create", activePayload);
  const lostWorker = randomUUID();
  const lostSpec = {
    ...activePayload,
    commandId: lostWorker,
    argv: [
      "/bin/sh",
      "-ec",
      "printf x >> /workspace/lost-count; printf WORKER-READY; read value",
    ],
  };
  await request("terminal-start", lostSpec);
  let workerReady = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const output = (await request("command-output", {
      ...activePayload,
      commandId: lostWorker,
      channel: "stdout",
      offset: 0,
      bytes: 1024,
    })) as { base64: string };
    if (
      Buffer.from(output.base64, "base64").toString().includes("WORKER-READY")
    ) {
      workerReady = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(workerReady, true);
  await promisify(execFile)(
    "sudo",
    [
      "python3",
      "-c",
      `
import os, pathlib, signal, sys
matches = []
for entry in pathlib.Path("/proc").iterdir():
    if not entry.name.isdecimal():
        continue
    try:
        args = (entry / "cmdline").read_bytes().split(b"\\0")[:-1]
        if len(args) == 5 and args[2] == b"/opt/jetski/host/commands.py" and args[3] == sys.argv[1].encode():
            fd = os.pidfd_open(int(entry.name))
            if (entry / "cmdline").read_bytes().split(b"\\0")[:-1] != args:
                os.close(fd)
                continue
            matches.append(fd)
    except (FileNotFoundError, ProcessLookupError):
        continue
assert len(matches) == 1, "expected exactly one owned worker"
signal.pidfd_send_signal(matches[0], signal.SIGKILL)
os.close(matches[0])
`,
      lostWorker,
    ],
    { timeout: 10000 },
  );
  const lostOutcome = await waitCommand(lostWorker, activePayload);
  assert.equal(lostOutcome.phase, "uncertain");
  assert.equal(lostOutcome.reason, "worker_lost");
  assert.deepEqual(await request("terminal-start", lostSpec), lostOutcome);
  await assert.rejects(
    request("command-start", {
      ...activePayload,
      commandId: randomUUID(),
      argv: ["true"],
    }),
  );
  await assert.rejects(
    request("terminal-input", {
      ...activePayload,
      commandId: lostWorker,
      inputId: randomUUID(),
      input: {
        kind: "stdin",
        base64: Buffer.from("retry\n").toString("base64"),
      },
    }),
  );
  const lostState = (await request("inspect", activePayload)) as {
    phase: string;
  };
  assert.equal(lostState.phase, "quarantined");
  await request("quiesce", activePayload);
  assert.equal(
    (
      (await request("command-status", {
        ...activePayload,
        commandId: lostWorker,
      })) as { phase: string }
    ).phase,
    "uncertain",
  );
  await assert.rejects(
    request("release", {
      ...activePayload,
      publication: { checkpointId: randomUUID(), sha256: "a".repeat(64) },
    }),
  );
  await request("remove", activePayload);
  console.log(
    JSON.stringify({
      replaySafeFileUpload: true,
      sshControl: true,
      durableStreamAdmissionAndQuiescence: true,
      authenticatedRelayBytesAndCancellation: true,
      bootstrap: true,
      rootlessCreate: true,
      createReplay: true,
      staleFenceDenied: true,
      capture: true,
      verifiedLocalPublication: true,
      durableExecution: true,
      binaryOutputReconnect: true,
      durableHostTerminalInput: true,
      terminalInputAdmissionAckRecovery: true,
      terminalResizeSignalClose: true,
      killedWorkerQuarantinesWithoutReplay: true,
      assignmentCancellation: true,
      sourceDeletedTransportRecovery: true,
      repeatedCheckpointIdentical: true,
    }),
  );
} finally {
  // Only the exact owned assignment. A failed state is preserved in CI logs.
  await request("quiesce", activePayload).catch(() => {});
  await request("remove", activePayload).catch(() => {});
}
