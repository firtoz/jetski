/** Disposable CI only: real host commands behind an emulated provider envelope.
 * This is host-script qualification, not live cloud-provider qualification. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Json } from "../src/core/contracts.js";
import { HostTransportError } from "../src/core/transport.js";
import { BoatApi } from "../src/providers/boat.js";
import { BoatBootstrap } from "../src/providers/boat-bootstrap.js";
import { SqliteState } from "../src/state/sqlite.js";
import { BoatTransport } from "../src/transport/boat.js";
import { BoatStreamTransport } from "../src/transport/boat-stream.js";
import { qualifyHostStream } from "./qualify-host-stream.js";

if (process.env.GITHUB_ACTIONS !== "true" || !process.env.JETSKI_TEST_IMAGE)
  throw Error("Requires disposable configured CI host");
async function run(
  args: string[],
  input?: Buffer,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0]!, args.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [],
      errors: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("error", reject);
    child.stdin.on("error", reject);
    for (const [stream, target] of [
      [child.stdout, chunks],
      [child.stderr, errors],
    ] as const)
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) child.kill("SIGKILL");
        else target.push(chunk);
      });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(chunks).toString(),
        stderr: Buffer.concat(errors).toString(),
      });
    });
    child.stdin.end(input);
  });
}
assert.notEqual(
  process.getuid?.(),
  0,
  "Provider commands must run as the non-root guest",
);
const state = new SqliteState(":memory:");
const directories = new Set<string>();
let corrupt = false,
  uploads = 0,
  cleanups = 0;
let loseBootstrapAck = true;
let commandCalls = 0;
try {
  await state.transaction((tx) => {
    tx.put("boat-host/bx_ci", "allocation");
    tx.put("allocation", {
      id: "bx_ci",
      retired: false,
      owner: "qualification",
      expiresAt: Date.now() + 3600000,
    });
  });
  const api = new BoatApi("fixture-only", async (url, init) => {
    const body = JSON.parse(init?.body as string);
    if (String(url).endsWith("/sshkey")) {
      assert.match(body.key, /^ssh-ed25519 [A-Za-z0-9+/=]+$/);
      const registered = await run(
        ["sudo", "tee", "-a", "/etc/ssh/jetski-test/authorized_keys"],
        Buffer.from(`${body.key}\n`),
      );
      assert.equal(registered.code, 0);
      const pinned = await run([
        "sudo",
        "cat",
        "/etc/ssh/jetski-test/host.pub",
      ]);
      assert.equal(pinned.code, 0);
      return Response.json({
        success: true,
        sshUser: "user",
        machineIp: "127.0.0.1",
        sshEndpoint: "127.0.0.1:2222",
        hostKey: pinned.stdout.trim(),
      });
    }
    if (String(url).endsWith("/files")) {
      assert.match(
        body.path,
        /^\/tmp\/jetski-control-[0-9a-f-]{36}\/request.json$/,
      );
      const data = Buffer.from(body.content, "base64");
      if (corrupt) data[0] = data[0]! ^ 1;
      const write = await run(
        [
          "python3",
          "-I",
          "-c",
          "import os,sys; f=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600); data=sys.stdin.buffer.read(); out=os.fdopen(f,'wb'); out.write(data); out.flush(); os.fsync(out.fileno()); out.close()",
          body.path,
        ],
        data,
      );
      assert.equal(write.code, 0, "fixture file write failed");
      uploads++;
      return Response.json({
        success: true,
        path: body.path,
        size: data.length,
      });
    }
    assert.equal(
      String(url),
      "https://boat.dev/api/v1/sandboxes/bx_ci/commands",
    );
    assert.ok(Buffer.byteLength(body.command) < 128 * 1024);
    const directory = /\/tmp\/jetski-control-[0-9a-f-]{36}/.exec(
      body.command,
    )?.[0];
    if (directory) directories.add(directory);
    commandCalls++;
    const result = await run(["sh", "-c", body.command]);
    if (body.command.includes("bytes.fromhex") && result.code !== 0)
      console.error("Fixture bootstrap failed:", result.stderr.slice(-8192));
    if (
      body.command.includes("bytes.fromhex") &&
      result.code === 0 &&
      loseBootstrapAck
    ) {
      loseBootstrapAck = false;
      throw Error("Injected committed bootstrap acknowledgement loss");
    }
    if (body.command.includes("os.rmdir")) {
      assert.equal(result.code, 0, "private request cleanup failed");
      cleanups++;
    }
    return Response.json({
      success: result.code === 0,
      exitCode: result.code,
      timedOut: false,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  });
  const bootstrap = new BoatBootstrap(state, api, "ci", [
    process.env.JETSKI_TEST_IMAGE!,
  ]);
  await assert.rejects(bootstrap.ensure("bx_ci"), HostTransportError);
  assert.equal(
    loseBootstrapAck,
    false,
    "Fault must follow successful installation",
  );
  await new BoatBootstrap(state, api, "ci", [
    process.env.JETSKI_TEST_IMAGE!,
  ]).ensure("bx_ci");
  assert.equal((await run(["stat", "-c", "%u", "/opt"])).stdout.trim(), "0");
  const callsAfterBootstrap = commandCalls;
  await bootstrap.ensure("bx_ci");
  assert.equal(
    commandCalls,
    callsAfterBootstrap,
    "Completed bootstrap must not reinstall",
  );
  await assert.rejects(
    new BoatBootstrap(state, api, "other", [
      process.env.JETSKI_TEST_IMAGE!,
    ]).ensure("bx_ci"),
    /identity changed/,
  );
  const transport = new BoatTransport(state, api);
  for (const payload of [null, { data: "雪'$(false)\u0000".repeat(20000) }]) {
    const reply = await transport.request("bx_ci", {
      version: 1,
      id: randomUUID(),
      action: "status",
      payload,
    });
    assert.ok(
      reply.result &&
        typeof reply.result === "object" &&
        !Array.isArray(reply.result) &&
        reply.result.ready === true,
    );
  }
  corrupt = true;
  await assert.rejects(
    transport.request("bx_ci", {
      version: 1,
      id: randomUUID(),
      action: "status",
      payload: "x".repeat(100000),
    }),
    HostTransportError,
  );
  assert.equal(uploads, 4);
  assert.equal(cleanups, 4);
  for (const directory of directories)
    assert.equal((await run(["test", "!", "-e", directory])).code, 0);
  corrupt = false;
  const request = async (action: string, payload: Json) =>
    (
      await transport.request("bx_ci", {
        version: 1,
        id: randomUUID(),
        action,
        payload,
      })
    ).result;
  const payload = {
    image: process.env.JETSKI_TEST_IMAGE!,
    lease: {
      owner: "qualification",
      poolId: "ci",
      machineId: "bx_ci",
      slotId: randomUUID(),
      sandboxId: randomUUID(),
      assignmentId: randomUUID(),
      generation: 1,
    },
  };
  await request("claim", { lease: payload.lease });
  try {
    await request("create", payload);
    await qualifyHostStream(
      {
        id: "bx_ci",
        hostname: "127.0.0.1",
        port: 2222,
        user: "root",
        privateKeyPath: process.env.JETSKI_TEST_SSH_KEY!,
        knownHostsPath: process.env.JETSKI_TEST_KNOWN_HOSTS!,
      },
      payload,
      request,
      new BoatStreamTransport(state, api),
    );
  } finally {
    await request("quiesce", payload);
    await request("remove", payload);
  }
  console.log(
    JSON.stringify({
      provider: "emulated",
      realHostControl: true,
      realEncryptedStreams: true,
      nonRootProviderCommands: true,
      automaticBootstrap: true,
      bootstrapAcknowledgementRecovery: true,
      bootstrapPolicyConflictRejected: true,
      largeInputVerified: true,
      corruptInputRejected: true,
      privateDirectoriesCleaned: directories.size,
      liveBoatQualified: false,
    }),
  );
} finally {
  state.close();
}
