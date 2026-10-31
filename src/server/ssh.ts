import { randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import ssh2, { type Connection, type ServerChannel } from "ssh2";

const { Server, utils } = ssh2;

import { observationDelay } from "../client/wait.js";
import { OUTPUT_CHUNK, OUTPUT_LIMIT } from "../core/command-output.js";
import { identifier, type Json, type Scope } from "../core/contracts.js";
import type { HostConnection } from "../core/host-stream.js";
import type { SandboxManager } from "../core/manager.js";
import type { PortRegistry } from "../core/ports.js";
import type { StreamCoordinator } from "../core/streams.js";
import {
  type TerminalInput,
  terminalGeometry,
} from "../core/terminal-input.js";

export type SshGatewayBackend = Pick<
  SandboxManager,
  | "get"
  | "requireTerminal"
  | "terminalInput"
  | "terminalInputStatus"
  | "commandOutput"
  | "commandStatus"
> & {
  ports?: Pick<PortRegistry, "status">;
  streams?: Pick<StreamCoordinator, "open"> | undefined;
};
export type SshGatewayOptions = {
  hostKey: Buffer;
  principals: Array<{ owner: string; publicKey: string }>;
  maxConnections?: number;
};
/** An attachment gateway only. Never executes a local command or opens a host shell. */
export function createSshGateway(
  backend: SshGatewayBackend,
  options: SshGatewayOptions,
) {
  const maximum = options.maxConnections ?? 64;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 1024)
    throw Error("Invalid SSH connection bound");
  const keys = options.principals.map(({ owner, publicKey }) => {
    identifier(owner);
    const key = utils.parseKey(publicKey);
    if (key instanceof Error || Array.isArray(key) || key.isPrivateKey())
      throw Error("A public SSH key is required");
    return { owner, key, bytes: key.getPublicSSH() };
  });
  if (
    !keys.length ||
    new Set(keys.map(({ bytes }) => bytes.toString("base64"))).size !==
      keys.length
  )
    throw Error("Unique SSH principal keys required");
  let forwards = 0;
  const clients = new Set<Connection>();
  const tasks = new Set<Promise<void>>();
  const sockets = new Map<string, { socket: Socket; timer: NodeJS.Timeout }>();
  const ssh = new Server(
    { hostKeys: [options.hostKey], ident: "Jetski" },
    (client, info) => {
      if (clients.size >= maximum) {
        client.end();
        return;
      }
      clients.add(client);
      client.on("error", () => {});
      client.once("close", () => clients.delete(client));
      let scope: Scope | undefined;
      let attempts = 0;
      let used = false;
      let clientForwards = 0;
      const deadline = setTimeout(() => client.end(), 15000);
      client.once("close", () => clearTimeout(deadline));
      client.on("authentication", (context) => {
        if (++attempts > 8) {
          context.reject();
          client.end();
          return;
        }
        if (context.method !== "publickey") {
          context.reject(["publickey"]);
          return;
        }
        try {
          const sandbox = identifier(context.username);
          const entry = keys.find(
            ({ key, bytes }) =>
              key.type === context.key.algo &&
              bytes.length === context.key.data.length &&
              timingSafeEqual(bytes, context.key.data),
          );
          if (
            !entry ||
            (context.signature &&
              (!context.blob ||
                entry.key.verify(
                  context.blob,
                  context.signature,
                  context.hashAlgo,
                ) !== true))
          ) {
            context.reject(["publickey"]);
            return;
          }
          // An unsigned key probe is not authentication and must never assign identity.
          if (context.signature) scope = { owner: entry.owner, sandbox };
          context.accept();
        } catch {
          context.reject(["publickey"]);
        }
      });
      client.on("ready", () => {
        const pending = sockets.get(`${info.ip}/${info.port}`);
        if (pending) clearTimeout(pending.timer);
        if (!scope) {
          client.end();
          return;
        }
        const authorized = scope;
        client.on("tcpip", (accept, reject, target) => {
          const match =
            /^([A-Za-z0-9_-]{1,128})\.([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jetski$/.exec(
              target.destIP,
            );
          if (
            used ||
            clientForwards >= 8 ||
            forwards >= 64 ||
            !match ||
            !backend.ports ||
            !backend.streams
          ) {
            reject();
            return;
          }
          const ports = backend.ports,
            streams = backend.streams;
          const exposure = match[1]!,
            streamId = match[2]!;
          forwards++;
          clientForwards++;
          const abort = new AbortController();
          let channel: ServerChannel | undefined,
            connection: HostConnection | undefined;
          const close = () => {
            abort.abort();
            connection?.abort();
            channel?.close();
          };
          const lifetime = setTimeout(close, 3600000);
          const admission = setTimeout(close, 30000);
          client.once("close", close);
          const task = (async () => {
            if (!(await backend.get(authorized)))
              throw Error("Sandbox unavailable");
            const permission = await ports.status(authorized, exposure);
            if (!permission.available || permission.port !== target.destPort)
              throw Error("Port unavailable");
            abort.signal.throwIfAborted();
            connection = await streams.open(
              authorized,
              exposure,
              streamId,
              abort.signal,
            );
            abort.signal.throwIfAborted();
            channel = accept();
            clearTimeout(deadline);
            clearTimeout(admission);
            channel.on("error", close);
            channel.once("close", close);
            await pumpTcp(connection, channel, abort.signal);
          })()
            .catch(() => {
              if (!channel) reject();
              close();
            })
            .finally(() => {
              clearTimeout(admission);
              clearTimeout(lifetime);
              client.removeListener("close", close);
              close();
              forwards--;
              clientForwards--;
            });
          tasks.add(task);
          void task.finally(() => tasks.delete(task));
        });
        client.on("session", (accept, reject) => {
          if (used || clientForwards) {
            reject();
            return;
          }
          used = true;
          const session = accept();
          let channel: ServerChannel | undefined;
          let starting = false;
          let geometry: ReturnType<typeof terminalGeometry> | undefined;
          let terminal: string | undefined;
          let pending = 0;
          let tail = Promise.resolve();
          const abort = new AbortController();
          const close = () => {
            abort.abort();
            channel?.close();
          };
          client.once("close", close);
          session.on("error", close);
          const queue = (input: TerminalInput): Promise<void> => {
            if (!terminal || abort.signal.aborted || pending >= 64) {
              close();
              return Promise.reject(Error("SSH input unavailable"));
            }
            const id = randomUUID(),
              target = terminal;
            pending++;
            const work = tail.then(async () => {
              abort.signal.throwIfAborted();
              let outcome = await backend.terminalInput(
                authorized,
                target,
                id,
                input,
              );
              const expires = Date.now() + 30000;
              while (phase(outcome) === "queued") {
                if (Date.now() >= expires)
                  throw Error("SSH input receipt deadline");
                await observationDelay(abort.signal);
                outcome = await backend.terminalInputStatus(
                  authorized,
                  target,
                  id,
                );
              }
              if (phase(outcome) !== "sent")
                throw Error("SSH input delivery unresolved");
            });
            tail = work.catch(close).finally(() => {
              pending--;
            });
            return work;
          };
          session.on("pty", (acceptPty, rejectPty, info) => {
            if (channel || geometry) {
              rejectPty();
              return;
            }
            try {
              geometry = terminalGeometry({
                rows: info.rows,
                columns: info.cols,
              });
              acceptPty();
            } catch {
              rejectPty();
            }
          });
          session.on("window-change", (acceptResize, rejectResize, info) => {
            try {
              const size = terminalGeometry({
                rows: info.rows,
                columns: info.cols,
              });
              if (!terminal || !geometry) {
                rejectResize?.();
                return;
              }
              void queue({ kind: "resize", ...size }).then(
                () => acceptResize?.(),
                () => rejectResize?.(),
              );
            } catch {
              rejectResize?.();
            }
          });
          session.on("signal", (acceptSignal, rejectSignal, info) => {
            if (
              info.name !== "INT" &&
              info.name !== "QUIT" &&
              info.name !== "TSTP"
            ) {
              rejectSignal?.();
              return;
            }
            void queue({ kind: "signal", signal: info.name }).then(
              () => acceptSignal?.(),
              () => rejectSignal?.(),
            );
          });
          session.on("exec", (acceptCommand, rejectCommand, info) => {
            const match = /^attach ([A-Za-z0-9_-]+) (0|[1-9][0-9]*)$/.exec(
              info.command,
            );
            const offset = match ? Number(match[2]) : -1;
            if (
              starting ||
              channel ||
              !match ||
              !Number.isSafeInteger(offset) ||
              offset > OUTPUT_LIMIT
            ) {
              rejectCommand();
              return;
            }
            starting = true;
            const target = match[1]!;
            const task = (async () => {
              identifier(target);
              if (!(await backend.get(authorized)))
                throw Error("Sandbox unavailable");
              await backend.requireTerminal(authorized, target);
              abort.signal.throwIfAborted();
              terminal = target;
              channel = acceptCommand();
              clearTimeout(deadline);
              const lifetime = setTimeout(close, 3600000);
              channel.once("close", () => {
                clearTimeout(lifetime);
                abort.abort();
                client.end();
              });
              channel.on("error", close);
              if (geometry) await queue({ kind: "resize", ...geometry });
              const stream = channel;
              const input = async () => {
                for await (const chunk of stream) {
                  const bytes = Buffer.from(chunk);
                  for (let at = 0; at < bytes.length; at += 16384)
                    await queue({
                      kind: "stdin",
                      base64: bytes.subarray(at, at + 16384).toString("base64"),
                    });
                }
                // EOF detaches; only an explicit lifecycle request closes the remote terminal.
                close();
              };
              const output = pumpOutput(
                backend,
                authorized,
                target,
                offset,
                stream,
                abort.signal,
              );
              await Promise.allSettled([
                input().catch(close),
                output.catch(close),
              ]);
            })()
              .catch(() => {
                if (!channel) rejectCommand();
                close();
                client.end();
              })
              .finally(async () => {
                await tail;
              });
            tasks.add(task);
            void task.finally(() => tasks.delete(task));
          });
          // All other requests (shell, subsystem, env, agent/X11 forwarding) are
          // rejected by ssh2 when no handler is registered. No outer-host transport.
        });
      });
    },
  );
  const server = createServer((socket) => {
    if (sockets.size >= maximum) {
      socket.destroy();
      return;
    }
    const key = `${socket.remoteAddress}/${socket.remotePort}`;
    const timer = setTimeout(() => socket.destroy(), 15000);
    sockets.set(key, { socket, timer });
    socket.on("error", () => {});
    socket.once("close", () => {
      clearTimeout(timer);
      sockets.delete(key);
    });
    ssh.injectSocket(socket);
  });
  server.maxConnections = maximum;
  const closeConnections = () => {
    for (const client of clients) client.end();
    for (const { socket } of sockets.values()) socket.destroy();
  };
  return {
    server,
    close: async () => {
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      closeConnections();
      await Promise.allSettled([...tasks]);
      await closed;
    },
    closeConnections,
  };
}
function phase(value: Json): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value.phase
    : undefined;
}
async function pumpOutput(
  backend: SshGatewayBackend,
  scope: Scope,
  terminal: string,
  initialOffset: number,
  stream: ServerChannel,
  signal: AbortSignal,
) {
  let offset = initialOffset;
  while (!signal.aborted) {
    const raw = await backend.commandOutput(
      scope,
      terminal,
      "stdout",
      offset,
      OUTPUT_CHUNK,
    );
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      typeof raw.base64 !== "string" ||
      typeof raw.terminal !== "boolean" ||
      raw.base64.length > Math.ceil(OUTPUT_CHUNK / 3) * 4
    )
      throw Error("Invalid SSH output segment");
    const bytes = Buffer.from(raw.base64, "base64");
    if (
      bytes.toString("base64") !== raw.base64 ||
      bytes.length > OUTPUT_CHUNK ||
      raw.nextOffset !== offset + bytes.length ||
      offset + bytes.length > OUTPUT_LIMIT
    )
      throw Error("Invalid SSH output cursor");
    signal.throwIfAborted();
    if (bytes.length && !stream.write(bytes))
      await once(stream, "drain", { signal });
    offset += bytes.length;
    if (raw.terminal) {
      const result = await backend.commandStatus(scope, terminal);
      stream.exit(phase(result) === "succeeded" ? 0 : 1);
      stream.end();
      return;
    }
    if (!bytes.length) await observationDelay(signal);
  }
}

async function pumpTcp(
  connection: HostConnection,
  channel: ServerChannel,
  signal: AbortSignal,
) {
  const input = async () => {
    for await (const chunk of channel) {
      const bytes = Buffer.from(chunk);
      if (bytes.length > 2 * 1024 * 1024)
        throw Error("SSH input window exceeded");
      for (let at = 0; at < bytes.length; at += 16384) {
        signal.throwIfAborted();
        await connection.send(bytes.subarray(at, at + 16384));
      }
    }
    await connection.end();
  };
  const output = async () => {
    for await (const bytes of connection.output) {
      if (!(bytes instanceof Uint8Array) || bytes.length > 2 * 1024 * 1024)
        throw Error("Invalid host forwarding chunk");
      for (let at = 0; at < bytes.length; at += 16384) {
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error("SSH forwarding backpressure deadline")),
            5000,
          );
          channel.write(bytes.subarray(at, at + 16384), (error) => {
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
          });
        });
      }
    }
    // ServerChannel.end() closes both directions in ssh2. Send only SSH EOF so
    // the client can finish uploading after the workload has stopped sending.
    channel.eof();
  };
  const fail = (error: unknown) => {
    connection.abort();
    channel.close();
    throw error;
  };
  await Promise.all([
    input().catch(fail),
    output().catch(fail),
    connection.completed.catch(fail),
  ]);
}
