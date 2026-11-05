import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import type { HostProvider, Json } from "../src/core/contracts.js";
import type { HostTransport } from "../src/core/transport.js";
import { openJetski, runSandbox } from "../src/node.js";

const image = `example/linux@sha256:${"a".repeat(64)}`;
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
// Protocol fixture only: actual SQLite, local objects and lifecycle orchestration;
// no assertion that these in-memory hosts qualify a container/provider runtime.
function hostFixture() {
  let starts = 0,
    retired = 0,
    failSave = false,
    failRetire = false;
  const hosts = new Set<string>(),
    actions: string[] = [];
  const files = new Map<string, string>();
  let archive = Buffer.alloc(0),
    imported: Buffer[] = [];
  let manifest: Json = null;
  const uploads = new Map<
    string,
    { receipt: Record<string, Json>; chunks: Buffer[] }
  >();
  let receipt: Record<string, Json> = {};
  const provider: HostProvider = {
    capabilities: () => ({
      kind: "machine-host",
      architecture: "x86_64",
      rootlessPodman: true,
    }),
    allocate: async (input) => {
      const id = `host-${++starts}`;
      hosts.add(id);
      return { id, allocationId: input.operationId };
    },
    inspect: async (id) => ({ state: hosts.has(id) ? "ready" : "absent" }),
    retire: async (id) => {
      hosts.delete(id);
      retired++;
      if (failRetire) {
        failRetire = false;
        throw Error("retirement ACK lost");
      }
    },
  };
  const transport: HostTransport = {
    request: async (host, request) => {
      assert.ok(hosts.has(host));
      actions.push(request.action);
      const p = request.payload as Record<string, Json>;
      let result: Json = null;
      switch (request.action) {
        case "file-read": {
          const bytes = Buffer.from(
            files.get(p.path as string) ?? "",
            "base64",
          );
          const offset = p.offset as number,
            part = bytes.subarray(offset, offset + (p.bytes as number));
          result = {
            base64: part.toString("base64"),
            offset,
            nextOffset: offset + part.length,
            size: bytes.length,
            eof: offset + part.length === bytes.length,
            version: sha(bytes),
            sha256: sha(part),
          };
          break;
        }
        case "file-list":
          result = {
            entries: [...files.keys()].map((path) => ({
              name: path.split("/").at(-1)!,
              kind: "file",
              mode: 420,
              size: Buffer.from(files.get(path)!, "base64").length,
            })),
            next: null,
            version: "a".repeat(64),
          };
          break;
        case "file-write-begin": {
          if (!uploads.has(p.uploadId as string))
            uploads.set(p.uploadId as string, {
              receipt: {
                id: p.uploadId!,
                path: p.path!,
                bytes: p.bytes!,
                sha256: p.sha256!,
                mode: p.mode!,
                offset: 0,
                phase: "receiving",
              },
              chunks: [],
            });
          result = { ...uploads.get(p.uploadId as string)!.receipt };
          break;
        }
        case "file-write-chunk": {
          const upload = uploads.get(p.uploadId as string)!,
            chunk = Buffer.from(p.base64 as string, "base64");
          assert.equal(upload.receipt.offset, p.offset);
          upload.chunks.push(chunk);
          upload.receipt.offset = (p.offset as number) + chunk.length;
          result = { ...upload.receipt };
          break;
        }
        case "file-write-finish": {
          const upload = uploads.get(p.uploadId as string)!,
            bytes = Buffer.concat(upload.chunks);
          assert.equal(sha(bytes), upload.receipt.sha256);
          files.set(upload.receipt.path as string, bytes.toString("base64"));
          upload.receipt.phase = "committed";
          result = { ...upload.receipt };
          break;
        }

        case "command-status":
          result = { id: p.commandId!, phase: "succeeded", exitCode: 0 };
          break;
        case "command-output": {
          const bytes = Buffer.from(
            p.channel === "stdout" ? "Hello, world!\n" : "",
          );
          const offset = p.offset as number,
            end = Math.min(bytes.length, offset + (p.bytes as number));
          result = {
            base64: bytes.subarray(offset, end).toString("base64"),
            nextOffset: end,
            terminal: end === bytes.length,
          };
          break;
        }
        case "capture": {
          const raw = Buffer.from(JSON.stringify([...files]));
          archive = gzipSync(raw);
          manifest = {
            version: 1,
            sha256: sha(archive),
            bytes: archive.length,
            expandedBytes: raw.length,
            entries: 2,
            frames: [
              {
                offset: 0,
                bytes: archive.length,
                expandedBytes: raw.length,
                sha256: sha(archive),
                expandedSha256: sha(raw),
              },
            ],
          };
          result = manifest;
          break;
        }
        case "read-checkpoint": {
          if (failSave) throw Error("save interrupted");
          const offset = p.offset as number,
            bytes = p.bytes as number;
          result = {
            offset,
            bytes,
            base64: archive.subarray(offset, offset + bytes).toString("base64"),
          };
          break;
        }
        case "import-begin":
          imported = [];
          receipt = {
            id: p.checkpointId!,
            sha256: p.sha256!,
            bytes: p.bytes!,
            offset: 0,
            phase: "receiving",
          };
          result = { ...receipt };
          break;
        case "import-chunk": {
          const part = Buffer.from(p.base64 as string, "base64");
          imported.push(part);
          receipt.offset = (receipt.offset as number) + part.length;
          result = { ...receipt };
          break;
        }
        case "import-finish": {
          const bytes = Buffer.concat(imported);
          assert.equal(sha(bytes), receipt.sha256);
          files.clear();
          for (const [key, value] of JSON.parse(gunzipSync(bytes).toString()))
            files.set(key, value);
          receipt.phase = "ready";
          result = { ...receipt };
          break;
        }
      }
      return { version: 1, id: request.id, result };
    },
  };
  return {
    provider: { kind: "custom" as const, id: "fixture", provider, transport },
    files,
    hosts,
    actions,
    get starts() {
      return starts;
    },
    get retired() {
      return retired;
    },
    loseRetireAck() {
      failRetire = true;
    },
    failSave(value: boolean) {
      failSave = value;
    },
  };
}
async function directory(t: { after: (fn: () => Promise<void>) => unknown }) {
  const path = await mkdtemp(join(tmpdir(), "jetski-node-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
test("embedded controller creates no listener/demand on open; persists identity, files and command output across replacement", async (t) => {
  const dataDirectory = await directory(t),
    host = hostFixture();
  const options = {
    provider: host.provider,
    dataDirectory,
    image,
    waitTimeoutMs: 5000,
  };
  const first = await openJetski(options);
  assert.equal(host.starts, 0);
  await assert.rejects(
    openJetski(options),
    /Controller could not open|lock|already/,
  );
  const sandbox = await first.create();
  host.files.set(
    "/workspace/binary",
    Buffer.from([0, 255, 128, 10]).toString("base64"),
  );
  const command = await sandbox.exec(["echo", "Hello, world!"]);
  assert.equal(command.stdout, "Hello, world!\n");
  const owner = first.owner;
  await first.close();
  await first.close();
  assert.equal(host.retired, 1);
  assert.equal(host.hosts.size, 0);
  assert.equal(first.health().closed, true);
  await assert.rejects(first.list(), /closed/);
  host.files.clear();
  const second = await openJetski(options);
  assert.equal(second.owner, owner);
  const restored = await second.get(sandbox.id);
  await restored.resume();
  assert.equal(host.starts, 2);
  assert.equal(host.files.get("/workspace/binary"), "AP+ACg==");
  const retained = await second.api.commandOutput(
    sandbox.id,
    command.id,
    "stdout",
  );
  assert.equal(
    Buffer.from((retained as { base64: string }).base64, "base64").toString(),
    command.stdout,
  );
  await restored.stop();
  await second.close();
  assert.equal(host.retired, 2);
  assert.equal(host.hosts.size, 0);
  const third = await openJetski(options);
  await third.close();
  assert.equal(host.starts, 2, "metadata-only restart never allocates");
  await assert.rejects(
    openJetski({ ...options, provider: { ...host.provider, id: "other" } }),
    /Controller could not open/,
  );
});
test("one-shot returns captured output only after publication and owned retirement", async (t) => {
  const dataDirectory = await directory(t),
    host = hostFixture();
  const result = await runSandbox(
    { provider: host.provider, dataDirectory, image, waitTimeoutMs: 5000 },
    ["echo", "Hello, world!"],
  );
  assert.equal(result.stdout, "Hello, world!\n");
  assert.equal(host.hosts.size, 0);
  assert.equal(host.retired, 1);
  assert.ok(host.actions.includes("capture"));
});
test("failed save closes control resources but preserves source and recoverable metadata", async (t) => {
  const dataDirectory = await directory(t),
    host = hostFixture();
  const options = {
    provider: host.provider,
    dataDirectory,
    image,
    waitTimeoutMs: 5000,
  };
  const first = await openJetski(options),
    sandbox = await first.create();
  host.files.set("/workspace/kept", "bytes");
  host.failSave(true);
  await assert.rejects(first.close(), /shutdown incomplete/);
  assert.equal(host.retired, 0);
  assert.equal(host.hosts.size, 1);
  assert.ok((await readFile(join(dataDirectory, "state.sqlite"))).length);
  host.failSave(false);
  const recovered = await openJetski(options);
  await recovered.manager.reconcile(recovered.owner);
  assert.equal((await recovered.get(sandbox.id)).id, sandbox.id);
  await recovered.close();
  assert.equal(host.hosts.size, 0);
  assert.equal(host.retired, 1);
});

test("shared session files, checkpoint history, pins and port permissions use the embedded contracts", async (t) => {
  const dataDirectory = await directory(t),
    host = hostFixture();
  const controller = await openJetski({
    provider: host.provider,
    dataDirectory,
    image,
    waitTimeoutMs: 5000,
  });
  try {
    const sandbox = await controller.create();
    await sandbox.writeFile("/workspace/hello.txt", "Héllo!\n");
    assert.equal(await sandbox.readText("/workspace/hello.txt"), "Héllo!\n");
    await sandbox.writeFile("/workspace/empty", new Uint8Array());
    assert.equal((await sandbox.readFile("/workspace/empty")).length, 0);
    await sandbox.writeFile("/workspace/binary", new Uint8Array([0, 255, 128]));
    assert.deepEqual(
      [...(await sandbox.readFile("/workspace/binary"))],
      [0, 255, 128],
    );
    await assert.rejects(sandbox.readText("/workspace/binary"));
    await assert.rejects(
      sandbox.readFile("/workspace/binary", { maxBytes: 2 }),
      /read bound/,
    );
    assert.equal((await sandbox.listFiles()).entries.length, 3);
    const exposure = await sandbox.exposePort(8080);
    assert.equal(exposure.available, true);
    await sandbox.revokePort(exposure.id);
    assert.equal(
      (await controller.api.portStatus(sandbox.id, exposure.id)).available,
      false,
    );
    const checkpoint = await sandbox.checkpoint();
    assert.equal((await sandbox.inspect()).phase, "stopped");
    await sandbox.pin(checkpoint.id, "saved");
    assert.ok(
      (await sandbox.checkpoints()).checkpoints.some(
        (entry) => entry.id === checkpoint.id,
      ),
    );
    await sandbox.resume({ checkpointId: checkpoint.id });
    assert.equal(await sandbox.readText("/workspace/hello.txt"), "Héllo!\n");
    await sandbox.stop();
    await sandbox.resume();
    await sandbox.stop();
    assert.equal(
      host.starts,
      1,
      "released host reused inside one controller lifetime",
    );
  } finally {
    await controller.close();
  }
});

test("lost retirement acknowledgement is reconciled from the existing journal without allocation", async (t) => {
  const dataDirectory = await directory(t),
    host = hostFixture();
  const options = {
    provider: host.provider,
    dataDirectory,
    image,
    waitTimeoutMs: 5000,
  };
  const first = await openJetski(options);
  await first.create();
  host.loseRetireAck();
  await assert.rejects(first.close(), /shutdown incomplete/);
  assert.equal(host.starts, 1);
  assert.equal(host.hosts.size, 0);
  const recovered = await openJetski(options);
  await recovered.manager.reconcile(recovered.owner);
  await recovered.close();
  assert.equal(host.starts, 1);
  assert.equal(
    host.retired,
    2,
    "same retirement observed/retried, no new demand",
  );
});
test("Boat/R2 composition needs no allocation on open and excludes credentials from persisted identity", async (t) => {
  const dataDirectory = await directory(t);
  const options = {
    provider: { kind: "boat" as const, token: "private-boat-fixture-token" },
    dataDirectory,
    image,
    storage: {
      kind: "s3" as const,
      endpoint: "https://storage.invalid",
      bucket: "fixture-bucket",
      prefix: "example",
      region: "auto",
      credentials: {
        accessKeyId: "private-access-fixture",
        secretAccessKey: "private-secret-fixture",
      },
    },
    scheduler: () => async () => {},
  };
  const controller = await openJetski(options);
  await controller.close();
  const bytes = await readFile(join(dataDirectory, "state.sqlite"));
  for (const secret of [
    options.provider.token,
    options.storage.credentials.accessKeyId,
    options.storage.credentials.secretAccessKey,
  ])
    assert.equal(bytes.includes(Buffer.from(secret)), false);
  const rotated = await openJetski({
    ...options,
    provider: { ...options.provider, token: "rotated-fixture-token" },
  });
  await rotated.close();
});

test("new sandbox resumes an independent retained checkpoint without running the original", async (t) => {
  const dataDirectory = await directory(t),
    host = hostFixture();
  const controller = await openJetski({
    provider: host.provider,
    dataDirectory,
    image,
    waitTimeoutMs: 5000,
  });
  try {
    const original = await controller.create();
    await original.writeFile(
      "/workspace/file",
      new Uint8Array([0, 255, 128, 10]),
    );
    const checkpoint = await original.checkpoint({ releaseHost: true });
    assert.equal((await original.inspect()).lease, null);
    await original.pin(checkpoint.id, "example");
    const restored = await controller.fromCheckpoint({
      sourceSandboxId: original.id,
      checkpointId: checkpoint.id,
    });
    assert.notEqual(restored.id, original.id);
    assert.equal((await restored.inspect()).phase, "stopped");
    assert.notEqual((await restored.inspect()).checkpoint, checkpoint.id);
    assert.equal(host.starts, 1, "copy publication does not allocate compute");
    await restored.resume();
    assert.deepEqual(
      [...(await restored.readFile("/workspace/file"))],
      [0, 255, 128, 10],
    );
    await original.delete();
    await restored.writeFile("/workspace/file", "independent");
    await restored.stop();
    await restored.resume();
    assert.equal(await restored.readText("/workspace/file"), "independent");
    assert.equal((await original.inspect()).phase, "deleted");
    assert.equal(
      host.starts,
      1,
      "same-owner host reuse is independent of sandbox identity",
    );
  } finally {
    await controller.close();
  }
});
