import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect as connectSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import ssh2, {
  type ClientChannel,
  type ParsedKey,
  type Client as SshClient,
} from "ssh2";
import { fixtureSshKey } from "../examples/fixture-ssh-key.js";

const { Client, utils } = ssh2;

import { forwardTcp } from "../src/client/forward.js";
import type { Json, Scope } from "../src/core/contracts.js";
import { createSshGateway, type SshGatewayBackend } from "../src/server/ssh.js";

const host = fixtureSshKey();
const alice = fixtureSshKey();
const bob = fixtureSshKey();
const stranger = fixtureSshKey();

test("SSH gateway authenticates keys, scopes attachments, denies host commands and forwards bounded input", {
  timeout: 15000,
}, async (t) => {
  const inputs: Json[] = [],
    reads: Scope[] = [];
  const backend: SshGatewayBackend = {
    get: async (scope) =>
      scope.owner === "alice" && scope.sandbox === "box"
        ? {
            id: "box",
            owner: "alice",
            image: "fixture",
            createOperation: "create",
            placementOperation: "place",
            restoreCheckpoint: null,
            pendingResume: null,
            phase: "running",
            lease: null,
            checkpoint: null,
            generation: 1,
          }
        : undefined,
    requireTerminal: async (_scope, id) => {
      assert.equal(id, "term");
    },
    terminalInput: async (_scope, _terminal, id, input) => {
      inputs.push(input as Json);
      return { id, phase: "sent" };
    },
    terminalInputStatus: async () => {
      throw Error("Unexpected observation");
    },
    commandOutput: async (scope, _terminal, _channel, offset) => {
      reads.push(scope);
      const bytes = Buffer.from("hello\0world");
      return {
        base64: bytes.subarray(offset).toString("base64"),
        nextOffset: bytes.length,
        terminal: false,
      };
    },
    commandStatus: async () => ({ phase: "running" }),
  };
  const gateway = createSshGateway(backend, {
    hostKey: Buffer.from(host.private),
    principals: [
      { owner: "alice", publicKey: alice.public },
      { owner: "bob", publicKey: bob.public },
    ],
  });
  await new Promise<void>((resolve) =>
    gateway.server.listen(0, "127.0.0.1", resolve),
  );
  const address = gateway.server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  const clients: SshClient[] = [];
  t.after(async () => {
    for (const client of clients) client.destroy();
    gateway.closeConnections();
    await new Promise<void>((resolve) => gateway.server.close(() => resolve()));
  });
  async function connect(key: string, username = "box") {
    const client = new Client();
    clients.push(client);
    // Rejected channels and teardown may reset an already authenticated transport.
    client.on("error", () => {});
    const ready = once(client, "ready");
    client.connect({
      host: "127.0.0.1",
      port,
      username,
      privateKey: key,
      readyTimeout: 3000,
      hostVerifier: (key: Buffer) =>
        key.equals((utils.parseKey(host.public) as ParsedKey).getPublicSSH()),
    });
    await ready;
    return client;
  }
  async function exec(
    client: SshClient,
    command: string,
    pty = false,
  ): Promise<ClientChannel> {
    return new Promise((resolve, reject) =>
      client.exec(
        command,
        pty ? { pty: { rows: 24, cols: 80 } } : {},
        (error, channel) => (error ? reject(error) : resolve(channel)),
      ),
    );
  }
  await assert.rejects(connect(stranger.private));
  const other = await connect(bob.private);
  await assert.rejects(exec(other, "attach term 0"));
  assert.equal(reads.length, 0);
  const injected = await connect(alice.private);
  await assert.rejects(exec(injected, "attach term 0; id"));
  injected.end();
  const invalid = await connect(alice.private);
  await assert.rejects(exec(invalid, "attach term 9007199254740992"));
  invalid.end();
  const shellClient = await connect(alice.private);
  await assert.rejects(
    new Promise((resolve, reject) =>
      shellClient.shell((error, channel) =>
        error ? reject(error) : resolve(channel),
      ),
    ),
  );
  shellClient.end();
  const forwardClient = await connect(alice.private);
  await assert.rejects(
    new Promise((resolve, reject) =>
      forwardClient.forwardOut(
        "127.0.0.1",
        1234,
        "127.0.0.1",
        22,
        (error, channel) => (error ? reject(error) : resolve(channel)),
      ),
    ),
  );
  forwardClient.end();
  const subsystemClient = await connect(alice.private);
  await assert.rejects(
    new Promise((resolve, reject) =>
      subsystemClient.sftp((error, channel) =>
        error ? reject(error) : resolve(channel),
      ),
    ),
  );
  subsystemClient.end();
  const connection = await connect(alice.private);
  const channel = await exec(connection, "attach term 0", true);
  const output = await once(channel, "data");
  assert.deepEqual(output[0], Buffer.from("hello\0world"));
  channel.write(Buffer.alloc(20000, 123));
  channel.setWindow(31, 91, 0, 0);
  channel.signal("INT");
  const deadline = Date.now() + 3000;
  while (
    inputs.filter((entry) => (entry as { kind: string }).kind === "stdin")
      .length < 2 ||
    !inputs.some((entry) => (entry as { signal?: string }).signal === "INT")
  ) {
    assert.ok(Date.now() < deadline);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const data = inputs
    .filter((entry) => (entry as { kind: string }).kind === "stdin")
    .map((entry) =>
      Buffer.from((entry as { base64: string }).base64, "base64"),
    );
  assert.ok(data.every((chunk) => chunk.length <= 16384));
  assert.deepEqual(Buffer.concat(data), Buffer.alloc(20000, 123));
  assert.ok(
    inputs.some(
      (entry) =>
        (entry as { rows?: number; columns?: number }).rows === 31 &&
        (entry as { columns?: number }).columns === 91,
    ),
  );
  channel.close();
  connection.end();
  const resumed = await connect(alice.private);
  const again = await exec(resumed, "attach term 6");
  assert.deepEqual((await once(again, "data"))[0], Buffer.from("world"));
  again.close();
  resumed.end();
  assert.ok(
    reads.every((scope) => scope.owner === "alice" && scope.sandbox === "box"),
  );
  assert.ok(
    !inputs.some((entry) => (entry as { kind: string }).kind === "close"),
  );
});

test("SSH gateway shutdown closes silent pre-header sockets", {
  timeout: 3000,
}, async () => {
  const unavailable = async (): Promise<never> => {
    throw Error("Backend must not be reached");
  };
  const gateway = createSshGateway(
    {
      get: unavailable,
      requireTerminal: unavailable,
      terminalInput: unavailable,
      terminalInputStatus: unavailable,
      commandOutput: unavailable,
      commandStatus: unavailable,
    },
    {
      hostKey: Buffer.from(host.private),
      principals: [{ owner: "alice", publicKey: alice.public }],
    },
  );
  await new Promise<void>((resolve) =>
    gateway.server.listen(0, "127.0.0.1", resolve),
  );
  const address = gateway.server.address();
  assert.ok(address && typeof address !== "string");
  const socket = connectSocket(address.port, "127.0.0.1");
  socket.on("error", () => {});
  await once(socket, "connect");
  socket.resume();
  const closed = once(socket, "close");
  await gateway.close();
  await closed;
});

test("SSH forwarding scopes targets, preserves binary data and supports remote-first half-close", {
  timeout: 15000,
}, async (t) => {
  const drainPayload = Buffer.alloc(2 * 1024 * 1024, 0x91);
  const identities = new Set<string>(),
    uploads: Buffer[] = [];
  const aborters = new Map<string, () => void>();
  const outcomes = new Map<string, Promise<void>>();
  const backend: SshGatewayBackend = {
    get: async (scope) =>
      scope.owner === "alice" && scope.sandbox === "box"
        ? {
            id: "box",
            owner: "alice",
            image: "fixture",
            createOperation: "create",
            placementOperation: "place",
            restoreCheckpoint: null,
            pendingResume: null,
            phase: "running",
            lease: null,
            checkpoint: null,
            generation: 1,
          }
        : undefined,
    requireTerminal: async () => {
      throw Error("unused");
    },
    terminalInput: async () => {
      throw Error("unused");
    },
    terminalInputStatus: async () => {
      throw Error("unused");
    },
    commandOutput: async () => {
      throw Error("unused");
    },
    commandStatus: async () => {
      throw Error("unused");
    },
    ports: {
      async status(scope, id) {
        assert.equal(scope.owner, "alice");
        return {
          id,
          generation: 1,
          revoked: false,
          available: id === "echo" || id === "half" || id === "drain",
          port: 8080,
        };
      },
    },
    streams: {
      async open(scope, exposure, id, signal) {
        assert.deepEqual(scope, { owner: "alice", sandbox: "box" });
        assert.ok(!identities.has(id), "No stream replay");
        identities.add(id);
        const output = new PassThrough();
        let resolve!: () => void,
          reject!: (error: Error) => void,
          ended = false,
          settled = false;
        const completed = new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        outcomes.set(id, completed);
        void completed.catch(() => {});
        const abort = () => {
          if (!settled) {
            settled = true;
            ended = true;
            output.destroy();
            reject(Error("interrupted"));
          }
        };
        aborters.set(id, abort);
        signal?.addEventListener("abort", abort, { once: true });
        if (exposure === "half") output.end(Buffer.from("read-finished"));
        return {
          output,
          completed,
          abort,
          async send(bytes) {
            assert.ok(bytes.length <= 16384);
            await new Promise((resolve) => setTimeout(resolve, 25));
            uploads.push(Buffer.from(bytes));
            if (exposure === "echo") output.write(bytes);
          },
          async end() {
            if (ended) throw Error("already ended");
            ended = true;
            if (exposure === "echo") output.end();
            if (exposure === "drain") output.end(drainPayload);
            await new Promise((resolve) => setTimeout(resolve, 100));
            if (settled) throw Error("Interrupted before final receipt");
            settled = true;
            resolve();
          },
        };
      },
    },
  };
  const gateway = createSshGateway(backend, {
    hostKey: Buffer.from(host.private),
    principals: [
      { owner: "alice", publicKey: alice.public },
      { owner: "bob", publicKey: bob.public },
    ],
  });
  await new Promise<void>((resolve) =>
    gateway.server.listen(0, "127.0.0.1", resolve),
  );
  const address = gateway.server.address();
  assert.ok(address && typeof address !== "string");
  const clients: SshClient[] = [];
  t.after(async () => {
    for (const client of clients) client.destroy();
    await gateway.close();
  });
  async function connect(key: string) {
    const client = new Client();
    clients.push(client);
    client.on("error", () => {});
    const ready = once(client, "ready");
    client.connect({
      host: "127.0.0.1",
      port: (address as { port: number }).port,
      username: "box",
      privateKey: key,
      hostVerifier: (key: Buffer) =>
        key.equals((utils.parseKey(host.public) as ParsedKey).getPublicSSH()),
    });
    await ready;
    return client;
  }
  async function forward(
    client: SshClient,
    exposure: string,
    id: string,
    port = 8080,
  ): Promise<ClientChannel> {
    return new Promise((resolve, reject) =>
      client.forwardOut(
        "127.0.0.1",
        1234,
        `${exposure}.${id}.jetski`,
        port,
        (error, channel) => (error ? reject(error) : resolve(channel)),
      ),
    );
  }
  const a = await connect(alice.private),
    b = await connect(bob.private);
  await assert.rejects(forward(b, "echo", randomUUID()));
  await assert.rejects(forward(a, "echo", randomUUID(), 22));
  await assert.rejects(forward(a, "missing", randomUUID()));
  assert.equal(identities.size, 0);
  const id = randomUUID(),
    echo = await forward(a, "echo", id);
  echo.on("error", () => {});
  const bytes = Buffer.from(Array.from({ length: 65536 }, (_, i) => i % 251));
  const chunks: Buffer[] = [];
  echo.on("data", (part: Buffer) => chunks.push(Buffer.from(part)));
  const closed = once(echo, "close");
  echo.end(bytes);
  await closed;
  await outcomes.get(id);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  await assert.rejects(forward(a, "echo", id));
  const halfId = randomUUID(),
    half = await forward(a, "half", halfId);
  half.on("error", () => {});
  const response: Buffer[] = [];
  half.on("data", (part: Buffer) => response.push(Buffer.from(part)));
  await once(half, "end");
  assert.equal(Buffer.concat(response).toString(), "read-finished");
  const halfClosed = once(half, "close");
  half.end(bytes);
  await halfClosed;
  await outcomes.get(halfId);
  assert.deepEqual(Buffer.concat(uploads), Buffer.concat([bytes, bytes]));
  const idleId = randomUUID(),
    idle = await forward(a, "half", idleId);
  idle.on("error", () => {});
  idle.resume();
  await once(idle, "end");
  const cancelled = once(idle, "close");
  aborters.get(idleId)!();
  await cancelled;
  const tunnelIds: string[] = [];
  const config = {
    host: "127.0.0.1",
    port: address.port,
    privateKey: alice.private,
    hostPublicKey: host.public,
    sandbox: "box",
    exposure: "echo",
    remotePort: 8080,
    onStream: (id: string) => {
      tunnelIds.push(id);
    },
  };
  await assert.rejects(
    forwardTcp({ ...config, hostPublicKey: stranger.public }),
  );
  const localBytes = Buffer.concat(Array.from({ length: 16 }, () => bytes));
  for (const exposure of ["echo", "half"]) {
    const tunnel = await forwardTcp({ ...config, exposure });
    t.after(() => tunnel.close());
    assert.equal(tunnel.host, "127.0.0.1");
    const local = connectSocket({
      host: tunnel.host,
      port: tunnel.port,
      allowHalfOpen: true,
    });
    local.on("error", () => {});
    t.after(() => local.destroy());
    const received: Buffer[] = [];
    local.on("data", (bytes: Buffer) => received.push(Buffer.from(bytes)));
    const localClosed = once(local, "close");
    if (exposure === "half") await once(local, "end");
    local.end(localBytes);
    await localClosed;
    const streamId = tunnelIds.at(-1)!;
    await outcomes.get(streamId);
    assert.deepEqual(
      Buffer.concat(received),
      exposure === "echo" ? localBytes : Buffer.from("read-finished"),
    );
    tunnel.close();
    await tunnel.done;
    await assert.rejects(
      new Promise<void>((resolve, reject) => {
        const probe = connectSocket({ host: tunnel.host, port: tunnel.port });
        probe.once("error", reject);
        probe.once("connect", () => {
          probe.destroy();
          resolve();
        });
      }),
    );
  }
  // A viewer shutdown must half-close and drain, not destroy its transport
  // before the host's independently verified completion can arrive.
  const drained = await forwardTcp({ ...config, exposure: "echo" });
  t.after(() => drained.close());
  const idleInput = connectSocket({
    host: drained.host,
    port: drained.port,
    allowHalfOpen: true,
  });
  idleInput.on("error", () => {});
  t.after(() => idleInput.destroy());
  const echoed = once(idleInput, "data");
  idleInput.write(Buffer.from("drain-without-client-fin"));
  await echoed;
  const drainId = tunnelIds.at(-1)!;
  await drained.drain();
  await outcomes.get(drainId);
  await drained.done;
  const drainResponse = await forwardTcp({ ...config, exposure: "drain" });
  t.after(() => drainResponse.close());
  const slowReader = connectSocket({
    host: drainResponse.host,
    port: drainResponse.port,
  });
  slowReader.on("error", () => {});
  t.after(() => slowReader.destroy());
  const responseChunks: Buffer[] = [];
  slowReader.on("data", (bytes: Buffer) =>
    responseChunks.push(Buffer.from(bytes)),
  );
  const responseClosed = once(slowReader, "close");
  await once(slowReader, "connect");
  slowReader.pause();
  const responseDrain = drainResponse.drain();
  setTimeout(() => slowReader.resume(), 100);
  await responseDrain;
  await responseClosed;
  assert.deepEqual(
    Buffer.concat(responseChunks),
    drainPayload,
    "drain must flush the final buffered output before destroying the local socket",
  );
  const priorAdmissions = identities.size;
  const unrecorded = await forwardTcp({
    ...config,
    onStream: () => {
      throw Error("journal unavailable");
    },
  });
  const refused = connectSocket({
    host: unrecorded.host,
    port: unrecorded.port,
  });
  refused.on("error", () => {});
  await once(refused, "close");
  assert.equal(identities.size, priorAdmissions);
  unrecorded.close();
  await unrecorded.done;
  // Exercise the actual CLI entrypoint/configuration and signal cleanup too.
  const directory = await mkdtemp(join(tmpdir(), "jetski-forward-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyPath = join(directory, "key"),
    pinPath = join(directory, "host.pub"),
    configPath = join(directory, "config.json");
  await writeFile(keyPath, alice.private, { mode: 0o600 });
  await writeFile(pinPath, host.public, { mode: 0o600 });
  await writeFile(
    configPath,
    JSON.stringify({
      host: "127.0.0.1",
      port: address.port,
      privateKeyPath: keyPath,
      hostPublicKeyPath: pinPath,
      remotePort: 8080,
    }),
    { mode: 0o600 },
  );
  const cli = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli.ts",
      "forward",
      "box",
      "echo",
      "--config",
      configPath,
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: { PATH: process.env.PATH },
    },
  );
  t.after(() => {
    cli.kill("SIGKILL");
  });
  const cliExit = once(cli, "exit");
  let cliStream = "",
    transcript = "";
  let resolveListening!: (port: number) => void,
    rejectListening!: (error: Error) => void;
  const listening = new Promise<number>((resolve, reject) => {
    resolveListening = resolve;
    rejectListening = reject;
  });
  const startupDeadline = setTimeout(() => {
    rejectListening(Error("CLI startup timeout"));
    cli.kill("SIGKILL");
  }, 15000);
  t.after(() => clearTimeout(startupDeadline));
  cli.once("error", rejectListening);
  cli.once("exit", () => rejectListening(Error("CLI exited before readiness")));
  cli.stderr.on("data", (chunk: Buffer) => {
    transcript += chunk.toString();
    if (transcript.length > 16384) {
      rejectListening(Error("Unexpected CLI output"));
      cli.kill("SIGKILL");
      return;
    }
    const lines = transcript.split("\n");
    transcript = lines.pop()!;
    for (const line of lines) {
      try {
        const value = JSON.parse(line);
        if (typeof value.streamId === "string") cliStream = value.streamId;
        if (value.host === "127.0.0.1" && Number.isInteger(value.port))
          resolveListening(value.port);
      } catch {
        rejectListening(Error("Unexpected CLI diagnostic"));
      }
    }
  });
  const cliPort = await listening;
  clearTimeout(startupDeadline);
  const cliSocket = connectSocket({
    host: "127.0.0.1",
    port: cliPort,
    allowHalfOpen: true,
  });
  t.after(() => cliSocket.destroy());
  const cliBytes: Buffer[] = [];
  cliSocket.on("data", (bytes: Buffer) => cliBytes.push(Buffer.from(bytes)));
  const cliClosed = once(cliSocket, "close");
  cliSocket.end(bytes);
  await cliClosed;
  assert.ok(cliStream);
  assert.ok(outcomes.has(cliStream));
  await outcomes.get(cliStream);
  assert.deepEqual(Buffer.concat(cliBytes), bytes);
  cli.kill("SIGTERM");
  assert.deepEqual(await cliExit, [0, null]);
  const probe = connectSocket({ host: "127.0.0.1", port: cliPort });
  await once(probe, "error");
  probe.destroy();
  const lost = await forwardTcp(config);
  t.after(() => lost.close());
  const loss = assert.rejects(lost.done, /transport lost/);
  gateway.closeConnections();
  await loss;
});

test("authenticated SSH connections survive the login deadline", {
  timeout: 22000,
}, async (t) => {
  const unavailable = async (): Promise<never> => {
    throw Error("No workload requested");
  };
  const gateway = createSshGateway(
    {
      get: unavailable,
      requireTerminal: unavailable,
      terminalInput: unavailable,
      terminalInputStatus: unavailable,
      commandOutput: unavailable,
      commandStatus: unavailable,
    },
    {
      hostKey: Buffer.from(host.private),
      principals: [{ owner: "alice", publicKey: alice.public }],
    },
  );
  const client = new Client();
  client.on("error", () => {});
  t.after(async () => {
    client.destroy();
    await gateway.close();
  });
  await new Promise<void>((resolve) =>
    gateway.server.listen(0, "127.0.0.1", resolve),
  );
  const address = gateway.server.address();
  assert.ok(address && typeof address !== "string");
  let closed = false;
  client.once("close", () => {
    closed = true;
  });
  const ready = once(client, "ready");
  client.connect({
    host: "127.0.0.1",
    port: address.port,
    username: "box",
    privateKey: alice.private,
    hostVerifier: (key: Buffer) =>
      key.equals((utils.parseKey(host.public) as ParsedKey).getPublicSSH()),
  });
  await ready;
  await new Promise((resolve) => setTimeout(resolve, 15750));
  assert.equal(
    closed,
    false,
    "login deadlines must not disconnect an authenticated transport",
  );
});
