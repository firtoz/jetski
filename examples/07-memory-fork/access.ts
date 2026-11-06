import { appendFileSync } from "node:fs";
import { forwardTcp } from "@firtoz/jetski/client/forward";
import type { NodeJetski } from "@firtoz/jetski/node";
import type { SandboxSession } from "@firtoz/jetski/sdk";
import { createSshGateway } from "@firtoz/jetski/server/ssh";
import { sshKeyPair } from "@firtoz/jetski/transport/ssh-key";

/** The viewer attaches through the same owner-scoped Jetski stream machinery as
 * other clients. Bootstrap/provider credentials never enter the desktop. */
export async function openDesktopGateway(
  jetski: NodeJetski,
  owner: string,
  streamReceipt: string,
) {
  const hostKey = sshKeyPair();
  const clientKey = sshKeyPair();
  const gateway = createSshGateway(jetski.manager, {
    hostKey: Buffer.from(hostKey.private),
    principals: [{ owner, publicKey: clientKey.public }],
  });
  await new Promise<void>((resolve) =>
    gateway.server.listen(0, "127.0.0.1", resolve),
  );
  const address = gateway.server.address();
  if (!address || typeof address === "string")
    throw Error("Desktop gateway unavailable");
  const connections = new Set<Awaited<ReturnType<typeof forwardTcp>>>();
  return {
    async attach(
      sandbox: SandboxSession,
      password: string,
      exposureId: string,
    ) {
      await sandbox.exposePort(6901, { operationId: exposureId });
      const streamIds: string[] = [];
      const tunnel = await forwardTcp({
        host: "127.0.0.1",
        port: address.port,
        privateKey: clientKey.private,
        hostPublicKey: hostKey.public,
        sandbox: sandbox.id,
        exposure: exposureId,
        remotePort: 6901,
        onStream(id) {
          streamIds.push(id);
          appendFileSync(
            streamReceipt,
            JSON.stringify({ sandbox: sandbox.id, id }) + "\n",
            { mode: 0o600, flush: true },
          );
        },
      });
      connections.add(tunnel);
      let failure: unknown;
      void tunnel.done.catch((error) => {
        failure = error;
      });
      const origin = `http://127.0.0.1:${tunnel.port}`;
      const headers = { Authorization: "Bearer " + password };
      const until = Date.now() + 45000;
      while (true) {
        if (failure) throw failure;
        try {
          const response = await fetch(origin + "/healthz", {
            signal: AbortSignal.timeout(5000),
          });
          await response.arrayBuffer();
          if (response.ok) break;
        } catch {}
        if (Date.now() >= until) {
          tunnel.close();
          connections.delete(tunnel);
          throw Error("Voxl did not become ready");
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return {
        url: origin + "/?token=" + encodeURIComponent(password),
        async screenshot() {
          if (failure) throw failure;
          const response = await fetch(origin + "/screenshot", {
            headers,
            signal: AbortSignal.timeout(15000),
          });
          if (!response.ok) throw Error("Desktop screenshot unavailable");
          return new Uint8Array(await response.arrayBuffer());
        },
        async close() {
          await tunnel.drain();
          const until = Date.now() + 15000;
          while (true) {
            const states = await Promise.all(
              streamIds.map((id) =>
                jetski.manager.streams!.inspect(
                  { owner, sandbox: sandbox.id },
                  id,
                ),
              ),
            );
            if (
              states.every(
                (state) =>
                  state.phase === "closed" || state.phase === "cancelled",
              )
            )
              break;
            if (Date.now() >= until)
              throw Error(
                "Viewer stream cleanup is unverified; do not capture RAM",
              );
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          connections.delete(tunnel);
        },
      };
    },
    async close() {
      for (const tunnel of connections) tunnel.close();
      await Promise.allSettled([...connections].map((tunnel) => tunnel.done));
      await gateway.close();
    },
  };
}
