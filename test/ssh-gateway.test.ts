import assert from "node:assert/strict";
import { once } from "node:events";
import { connect as connectSocket } from "node:net";
import { test } from "node:test";
import ssh2, {
  type ClientChannel,
  type ParsedKey,
  type Client as SshClient,
} from "ssh2";

const { Client, utils } = ssh2;

import type { Json, Scope } from "../src/core/contracts.js";
import { createSshGateway, type SshGatewayBackend } from "../src/server/ssh.js";

const host = utils.generateKeyPairSync("ed25519");
const alice = utils.generateKeyPairSync("ed25519");
const bob = utils.generateKeyPairSync("ed25519");
const stranger = utils.generateKeyPairSync("ed25519");

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
