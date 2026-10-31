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
let activePayload = payload;
await request("claim", { lease });
try {
  const created = await request("create", payload);
  assert.deepEqual(await request("create", payload), created);
  await assert.rejects(
    request("create", { ...payload, lease: { ...lease, generation: 2 } }),
  );
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
  assert.equal((await waitCommand(commandId)).phase, "succeeded");
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
  const cancelId = randomUUID();
  await request("command-start", {
    ...payload,
    commandId: cancelId,
    argv: ["/bin/sh", "-c", "sleep 30"],
  });
  await request("command-cancel", { ...payload, commandId: cancelId });
  assert.equal((await waitCommand(cancelId)).phase, "cancelled");
  await request("quiesce", payload);
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
    await request("import-begin", {
      ...activePayload,
      ...publication,
      bytes: manifest.bytes,
    });
    let importedOffset = 0;
    for (const frame of saved.root.frames) {
      for await (const part of store.read(frame)) {
        const chunk = {
          ...activePayload,
          offset: importedOffset,
          base64: Buffer.from(part).toString("base64"),
          sha256: createHash("sha256").update(part).digest("hex"),
        };
        const receipt = await request("import-chunk", chunk);
        if (importedOffset === 0)
          assert.deepEqual(await request("import-chunk", chunk), receipt);
        importedOffset += part.length;
      }
    }
    await request("import-finish", activePayload);
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
  console.log(
    JSON.stringify({
      replaySafeFileUpload: true,
      sshControl: true,
      bootstrap: true,
      rootlessCreate: true,
      createReplay: true,
      staleFenceDenied: true,
      capture: true,
      verifiedLocalPublication: true,
      durableExecution: true,
      binaryOutputReconnect: true,
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
