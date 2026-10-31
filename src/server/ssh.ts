import { randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import ssh2, { type Connection, type ServerChannel } from "ssh2";

const { Server, utils } = ssh2;

import { observationDelay } from "../client/wait.js";
import { OUTPUT_CHUNK, OUTPUT_LIMIT } from "../core/command-output.js";
import { identifier, type Json, type Scope } from "../core/contracts.js";
import type { SandboxManager } from "../core/manager.js";
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
>;
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
  const clients = new Set<Connection>();
  const tasks = new Set<Promise<void>>();
  const server = new Server(
    { hostKeys: [options.hostKey], ident: "Jetski" },
    (client) => {
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
        if (!scope) {
          client.end();
          return;
        }
        const authorized = scope;
        client.on("session", (accept, reject) => {
          if (used) {
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
  server.maxConnections = maximum;
  return {
    server,
    close: async () => {
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      for (const client of clients) client.end();
      await Promise.allSettled([...tasks]);
      await closed;
    },
    closeConnections: () => {
      for (const client of clients) client.end();
    },
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
