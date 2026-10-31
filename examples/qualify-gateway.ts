/** Invoked only by disposable installed API qualification. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import ssh2 from "ssh2";
import type { SandboxManager } from "../src/core/manager.js";
import type { JetskiClient } from "../src/sdk.js";
import { createSshGateway } from "../src/server/ssh.js";
import { fixtureSshKey } from "./fixture-ssh-key.js";

export async function qualifyGateway(
  manager: SandboxManager,
  client: JetskiClient,
  sandbox: string,
) {
  if (process.env.GITHUB_ACTIONS !== "true")
    throw Error("disposable_ci_required");
  const host = fixtureSshKey(),
    key = fixtureSshKey();
  const parsed = ssh2.utils.parseKey(host.public);
  assert.ok(!(parsed instanceof Error) && !Array.isArray(parsed));
  const hostBytes = parsed.getPublicSSH();
  const gateway = createSshGateway(manager, {
    hostKey: Buffer.from(host.private),
    principals: [{ owner: "qualification", publicKey: key.public }],
  });
  await new Promise<void>((resolve) =>
    gateway.server.listen(0, "127.0.0.1", resolve),
  );
  const address = gateway.server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  const connections: InstanceType<typeof ssh2.Client>[] = [];
  async function attach(terminal: string, offset: number) {
    const connection = new ssh2.Client();
    connections.push(connection);
    connection.on("error", () => {});
    const ready = once(connection, "ready");
    connection.connect({
      host: "127.0.0.1",
      port,
      username: sandbox,
      privateKey: key.private,
      readyTimeout: 5000,
      hostVerifier: (bytes: Buffer) => bytes.equals(hostBytes),
    });
    await ready;
    const stream = await new Promise<import("ssh2").ClientChannel>(
      (resolve, reject) =>
        connection.exec(
          `attach ${terminal} ${offset}`,
          { pty: { rows: 41, cols: 99 } },
          (error, channel) => (error ? reject(error) : resolve(channel)),
        ),
    );
    return { connection, stream };
  }
  try {
    const terminal = randomUUID();
    await client.startTerminal(sandbox, terminal, [
      "/bin/sh",
      "-ec",
      'stty -echo; printf GATEWAY-READY; IFS= read -r line; test "$line" = hello; stty size; printf GATEWAY-DONE',
    ]);
    const first = await attach(terminal, 0);
    const ready = await once(first.stream, "data", {
      signal: AbortSignal.timeout(15000),
    });
    assert.deepEqual(ready[0], Buffer.from("GATEWAY-READY"));
    const detached = once(first.stream, "close");
    first.stream.close();
    await detached;
    first.connection.end();
    assert.equal(
      ((await client.terminalStatus(sandbox, terminal)) as { phase: string })
        .phase,
      "running",
    );
    const second = await attach(terminal, Buffer.byteLength("GATEWAY-READY"));
    const chunks: Buffer[] = [];
    second.stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    const closed = once(second.stream, "close", {
      signal: AbortSignal.timeout(15000),
    });
    second.stream.write("hello\n");
    const [exit] = await closed;
    assert.equal(exit, 0);
    assert.deepEqual(
      Buffer.concat(chunks),
      Buffer.from("41 99\r\nGATEWAY-DONE"),
    );
    assert.equal(
      ((await client.terminalStatus(sandbox, terminal)) as { phase: string })
        .phase,
      "succeeded",
    );
    return true;
  } finally {
    for (const connection of connections) connection.destroy();
    await gateway.close();
  }
}
