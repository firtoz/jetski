/** Optional Node TCP tunnel client. No workload execution or automatic replay. */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import ssh2, { type ClientChannel, type ParsedKey } from "ssh2";
import { identifier } from "../core/contracts.js";

export type ForwardOptions = {
  host: string;
  port: number;
  privateKey: string | Buffer;
  hostPublicKey: string;
  sandbox: string;
  exposure: string;
  remotePort: number;
  localPort?: number;
  onStream(id: string): void;
};
function port(value: number, allowZero = false): number {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 65535)
    throw Error("Invalid forwarding port");
  return value;
}
/** The returned done promise rejects if the SSH transport is lost. Channel EOF
 * is not a durable completion receipt; inspect the operation identified by onStream. */
export async function forwardTcp(options: ForwardOptions) {
  if (
    typeof options.host !== "string" ||
    !options.host.trim() ||
    options.host.length > 253
  )
    throw Error("Gateway host required");
  identifier(options.sandbox);
  identifier(options.exposure);
  port(options.port);
  port(options.remotePort);
  const localPort = port(options.localPort ?? 0, true);
  const parsed = ssh2.utils.parseKey(options.hostPublicKey);
  if (parsed instanceof Error || Array.isArray(parsed) || parsed.isPrivateKey())
    throw Error("Pinned public gateway host key required");
  const pinned = (parsed as ParsedKey).getPublicSSH();
  const client = new ssh2.Client();
  const connections = new Map<Socket, { abort(): void; finishInput(): void }>();
  let stopping = false;
  let draining = false;
  let resolveDone!: () => void, rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  void done.catch(() => {});
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on("error", () => {});
    socket.pause();
    if (stopping || draining || connections.size >= 8) {
      socket.destroy();
      return;
    }
    let channel: ClientChannel | undefined;
    let closed = false;
    let inputFinishing = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(admission);
      clearTimeout(lifetime);
      channel?.destroy();
      socket.destroy();
      connections.delete(socket);
    };
    const admission = setTimeout(close, 30000);
    const lifetime = setTimeout(close, 3600000);
    const finishInput = () => {
      inputFinishing = true;
      socket.unpipe();
      socket.pause();
      // EOF is a half-close, not replay or cancellation. Keep reading remote
      // output until the gateway completes its independently verified stream.
      channel?.end();
    };
    connections.set(socket, { abort: close, finishInput });
    socket.once("close", () => {
      if (!inputFinishing) close();
    });
    const id = randomUUID();
    try {
      // Observers can persist this identity before dispatch. Failure to record it
      // must prevent admission, rather than creating an unobservable connection.
      options.onStream(id);
      client.forwardOut(
        "127.0.0.1",
        socket.remotePort ?? 0,
        `${options.exposure}.${id}.jetski`,
        options.remotePort,
        (error, opened) => {
          if (error) {
            close();
            return;
          }
          channel = opened;
          channel.on("error", close);
          channel.once("close", () => {
            if (inputFinishing) {
              if (socket.destroyed || socket.writableFinished) close();
              else {
                socket.once("finish", close);
                socket.end();
              }
              return;
            }
            // A normal SSH close can precede the local socket flushing its last
            // buffered output. Let net.Socket finish that output before cleanup.
            if (!socket.readableEnded || !socket.writableEnded) close();
          });
          if (closed) {
            channel.destroy();
            return;
          }
          clearTimeout(admission);
          // pipe preserves backpressure and each independent EOF. Do not use an
          // async iterator that destroys a duplex on readable EOF.
          socket.pipe(channel);
          channel.pipe(socket);
          if (inputFinishing) finishInput();
        },
      );
    } catch {
      close();
    }
  });
  server.maxConnections = 8;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => resolveDone());
    for (const connection of connections.values()) connection.abort();
    client.destroy();
  };
  const fail = (error: Error) => {
    if (stopping) return;
    rejectDone(error);
    stop();
  };
  client.on("error", fail);
  client.once("close", () =>
    fail(Error("Forward transport lost; never replay bytes")),
  );
  server.on("error", fail);
  try {
    const ready = once(client, "ready", { signal: AbortSignal.timeout(15000) });
    void ready.catch(() => {});
    client.connect({
      host: options.host,
      port: options.port,
      username: options.sandbox,
      privateKey: options.privateKey,
      readyTimeout: 15000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer) =>
        key.length === pinned.length && timingSafeEqual(key, pinned),
    });
    await ready;
    if (stopping) throw Error("Forward transport unavailable");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(localPort, "127.0.0.1", () => {
        server.removeListener("error", reject);
        if (stopping) {
          server.close();
          reject(Error("Forward transport unavailable"));
        } else resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("Listener unavailable");
    return {
      host: "127.0.0.1",
      port: address.port,
      done,
      close: stop,
      /** Stop producers first. Stop admission and half-close existing inputs without destroying the
       * transport before remote completion. Callers must still inspect stream
       * IDs: an SSH close alone is not proof of delivery or process cleanup. */
      async drain(timeoutMs = 15000) {
        if (
          !Number.isSafeInteger(timeoutMs) ||
          timeoutMs < 1 ||
          timeoutMs > 60000
        )
          throw Error("Invalid forwarding drain deadline");
        if (stopping) {
          await done;
          return;
        }
        draining = true;
        for (const connection of connections.values()) connection.finishInput();
        const until = Date.now() + timeoutMs;
        while (connections.size && !stopping && Date.now() < until)
          await new Promise((resolve) => setTimeout(resolve, 25));
        if (connections.size) {
          stop();
          throw Error(
            "Forward drain incomplete; inspect stream IDs before checkpointing",
          );
        }
        stop();
        await done;
      },
    };
  } catch (error) {
    stop();
    throw error;
  }
}
