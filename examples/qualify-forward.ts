/** Disposable installed-host forwarding qualification; no operator workloads. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";
import ssh2, { type ClientChannel } from "ssh2";
import { forwardTcp } from "../src/client/forward.js";
import type { Scope } from "../src/core/contracts.js";
import type { PortRegistry } from "../src/core/ports.js";
import type { StreamCoordinator } from "../src/core/streams.js";
import { createSshGateway } from "../src/server/ssh.js";

export async function qualifyForward(
  scope: Scope,
  ports: PortRegistry,
  streams: StreamCoordinator,
  half: boolean,
  local: boolean,
) {
  if (process.env.GITHUB_ACTIONS !== "true")
    throw Error("disposable_ci_required");
  const host = ssh2.utils.generateKeyPairSync("ed25519"),
    key = ssh2.utils.generateKeyPairSync("ed25519");
  const parsed = ssh2.utils.parseKey(host.public);
  assert.ok(!(parsed instanceof Error) && !Array.isArray(parsed));
  const unavailable = async (): Promise<never> => {
    throw Error("Terminal not part of forwarding fixture");
  };
  const gateway = createSshGateway(
    {
      get: async (requested) =>
        requested.owner === scope.owner && requested.sandbox === scope.sandbox
          ? {
              id: scope.sandbox,
              owner: scope.owner,
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
      requireTerminal: unavailable,
      terminalInput: unavailable,
      terminalInputStatus: unavailable,
      commandOutput: unavailable,
      commandStatus: unavailable,
      ports,
      streams,
    },
    {
      hostKey: Buffer.from(host.private),
      principals: [{ owner: scope.owner, publicKey: key.public }],
    },
  );
  let tunnel: Awaited<ReturnType<typeof forwardTcp>> | undefined;
  const client = new ssh2.Client();
  client.on("error", () => {});
  try {
    await new Promise<void>((resolve) =>
      gateway.server.listen(0, "127.0.0.1", resolve),
    );
    const address = gateway.server.address();
    assert.ok(address && typeof address !== "string");
    const ready = once(client, "ready", { signal: AbortSignal.timeout(15000) });
    client.connect({
      host: "127.0.0.1",
      port: address.port,
      username: scope.sandbox,
      privateKey: key.private,
      hostVerifier: (bytes: Buffer) => bytes.equals(parsed.getPublicSSH()),
    });
    await ready;
    let id: string = randomUUID();
    const open = () =>
      new Promise<ClientChannel>((resolve, reject) =>
        client.forwardOut(
          "127.0.0.1",
          1234,
          `fixture-port.${id}.jetski`,
          18080,
          (error, channel) => (error ? reject(error) : resolve(channel)),
        ),
      );
    if (local) {
      tunnel = await forwardTcp({
        host: "127.0.0.1",
        port: address.port,
        privateKey: key.private,
        hostPublicKey: host.public,
        sandbox: scope.sandbox,
        exposure: "fixture-port",
        remotePort: 18080,
        onStream: (assigned) => {
          id = assigned;
        },
      });
    }
    const channel = tunnel
      ? connect({ host: tunnel.host, port: tunnel.port, allowHalfOpen: true })
      : await open();
    channel.on("error", () => {});
    const chunks: Buffer[] = [];
    channel.on("data", (bytes: Buffer) => chunks.push(Buffer.from(bytes)));
    const closed = once(channel, "close", {
      signal: AbortSignal.timeout(15000),
    });
    if (half)
      await once(channel, "end", { signal: AbortSignal.timeout(15000) });
    channel.end("GET / HTTP/1.0\r\nHost: localhost\r\n\r\n");
    await closed;
    assert.ok(Buffer.concat(chunks).toString().endsWith("relay-container"));
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await streams.status(scope, id);
      if (status.phase === "closed") break;
      assert.equal(
        status.phase,
        "open",
        `Unexpected forwarding outcome (half=${half}, local=${local})`,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal((await streams.status(scope, id)).phase, "closed");
    await assert.rejects(open());
  } finally {
    tunnel?.close();
    if (tunnel) await tunnel.done;
    client.destroy();
    await gateway.close();
  }
}
