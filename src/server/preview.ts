/** Isolated-origin HTTP and WebSocket previews over fenced workload streams. */
import { createHash, randomUUID } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
} from "node:http";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { identifier } from "../core/contracts.js";
import type { SandboxManager } from "../core/manager.js";
import type { PortRegistry } from "../core/ports.js";
import type { PreviewSessions } from "../core/preview-sessions.js";
import type { StreamCoordinator } from "../core/streams.js";
import { HostDuplex } from "../transport/duplex.js";
import type { Authenticate } from "./http.js";
import { previewAuthRequest, previewCookie } from "./preview-auth.js";

export type PreviewRoute = {
  origin: string;
  owner: string;
  sandbox: string;
  exposure: string;
};
export type PreviewBackend = Pick<SandboxManager, "get"> & {
  ports: Pick<PortRegistry, "status">;
  streams: Pick<StreamCoordinator, "open"> | undefined;
};
class PreviewError extends Error {
  constructor(readonly status: number) {
    super("Preview unavailable");
  }
}
async function interruptible<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    signal.throwIfAborted();
  }
  let stop!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    stop = () => reject(Error("Preview interrupted"));
    signal.addEventListener("abort", stop, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
function headers(
  input: IncomingMessage["headers"],
  response = false,
): OutgoingHttpHeaders {
  const blocked = new Set([
    ...HOP,
    ...(input.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim()),
  ]);
  for (const name of [
    "authorization",
    "cookie",
    "set-cookie",
    "host",
    "origin",
    "referer",
    "forwarded",
    "www-authenticate",
    "strict-transport-security",
    "content-security-policy",
    "service-worker-allowed",
  ])
    blocked.add(name);
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(input)) {
    if (
      blocked.has(name) ||
      /^(x-forwarded-|proxy-|sec-fetch-|x-jetski-)/.test(name)
    )
      continue;
    if (value !== undefined) result[name] = value;
  }
  if (response) {
    result["content-security-policy"] =
      "sandbox allow-scripts allow-forms allow-same-origin; worker-src 'none'; frame-ancestors 'none'";
    result["referrer-policy"] = "no-referrer";
    result["x-content-type-options"] = "nosniff";
    result["cache-control"] = "no-store";
  }
  return result;
}
function origin(value: string): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw Error("HTTPS preview origin required outside loopback");
  return url;
}
/** Route origins must be separate from control origins and from each other.
 * TLS termination is operator-owned; the listener validates the original Host.
 * Browser navigation credentials remain an explicit embedding concern. */
export function createPreviewServer(
  backend: PreviewBackend,
  authenticate: Authenticate,
  options: {
    routes: PreviewRoute[];
    controlOrigins: string[];
    sessions?: PreviewSessions;
  },
) {
  if (!backend.streams) throw Error("Preview stream transport unavailable");
  if (
    !options.routes.length ||
    options.routes.length > 1024 ||
    !options.controlOrigins.length
  )
    throw Error("Explicit isolated preview routes required");
  const controls = new Set(
    options.controlOrigins.map((value) => origin(value).origin),
  );
  const routes = new Map<string, PreviewRoute>();
  for (const route of options.routes) {
    const url = origin(route.origin);
    identifier(route.owner);
    identifier(route.sandbox);
    identifier(route.exposure);
    if (controls.has(url.origin) || routes.has(url.host))
      throw Error("Preview origin must be isolated");
    routes.set(url.host, { ...route, origin: url.origin });
  }
  const streams = backend.streams;
  const sockets = new Set<Duplex>(),
    aborters = new Set<AbortController>();
  let active = 0;
  const tasks = new Set<Promise<void>>();
  const track = (task: Promise<void>) => {
    tasks.add(task);
    void task.finally(() => tasks.delete(task)).catch(() => {});
  };
  function routeFor(req: IncomingMessage) {
    const route = routes.get((req.headers.host ?? "").toLowerCase());
    if (!route) throw new PreviewError(404);
    if (!req.url?.startsWith("/") || req.url.startsWith("//"))
      throw new PreviewError(400);
    if (req.headers.origin && req.headers.origin !== route.origin)
      throw new PreviewError(403);
    return route;
  }
  async function prepare(req: IncomingMessage, abort: AbortController) {
    const route = routeFor(req);
    const scope = { owner: route.owner, sandbox: route.sandbox };
    const cookie = previewCookie(req.headers.cookie);
    const session =
      !req.headers.authorization && cookie && options.sessions
        ? await options.sessions.authenticate(
            scope,
            { exposureId: route.exposure, origin: route.origin },
            cookie,
          )
        : undefined;
    const principal =
      session ?? (await authenticate(req.headers.authorization));
    if (!principal) throw new PreviewError(401);
    if (principal.owner !== route.owner) throw new PreviewError(403);
    abort.signal.throwIfAborted();
    if (!(await backend.get(scope))) throw Error("Preview unavailable");
    const permission = await backend.ports.status(scope, route.exposure);
    if (!permission.available) throw Error("Preview unavailable");
    const id = randomUUID();
    const connection = await streams.open(
      scope,
      route.exposure,
      id,
      abort.signal,
    );
    const bridge = new HostDuplex(connection);
    bridge.on("error", () => {});
    return { route, id, bridge, port: permission.port, session, cookie };
  }
  function begin() {
    if (active >= 64) throw new PreviewError(429);
    active++;
    const abort = new AbortController();
    aborters.add(abort);
    const deadline = setTimeout(() => abort.abort(), 30000);
    const lifetime = setTimeout(() => abort.abort(), 3600000);
    const cleanups: Array<() => void> = [];
    return {
      abort,
      cleanups,
      admitted: () => clearTimeout(deadline),
      finish: () => {
        clearTimeout(deadline);
        clearTimeout(lifetime);
        for (const cleanup of cleanups) cleanup();
        aborters.delete(abort);
        active--;
      },
    };
  }
  function watchSession(
    target: Awaited<ReturnType<typeof prepare>>,
    work: ReturnType<typeof begin>,
  ) {
    if (!target.session || !target.cookie || !options.sessions) return;
    const cookie = target.cookie,
      sessions = options.sessions;
    const expiry = setTimeout(
      () => work.abort.abort(),
      Math.max(0, target.session.expiresAt - Date.now()),
    );
    let busy = false,
      stopped = false;
    const check = setInterval(() => {
      if (busy || stopped) return;
      busy = true;
      void sessions
        .authenticate(
          { owner: target.route.owner, sandbox: target.route.sandbox },
          { exposureId: target.route.exposure, origin: target.route.origin },
          cookie,
        )
        .then(
          (valid) => {
            if (!valid) work.abort.abort();
          },
          () => work.abort.abort(),
        )
        .finally(() => {
          busy = false;
        });
    }, 1000);
    work.cleanups.push(() => {
      stopped = true;
      clearTimeout(expiry);
      clearInterval(check);
    });
  }
  const server = createServer({ maxHeaderSize: 32768 }, (req, res) => {
    track(
      (async () => {
        let work: ReturnType<typeof begin> | undefined,
          bridge: HostDuplex | undefined;
        try {
          work = begin();
          res.once("close", () => {
            if (!res.writableFinished) work?.abort.abort();
          });
          if (
            options.sessions &&
            new URL(req.url ?? "/", "http://localhost").pathname.startsWith(
              "/.jetski/",
            )
          ) {
            const route = routeFor(req);
            await interruptible(
              previewAuthRequest(
                req,
                res,
                route,
                options.sessions,
                work.abort.signal,
              ),
              work.abort.signal,
            );
            return;
          }
          const target = await interruptible(
            prepare(req, work.abort),
            work.abort.signal,
          );
          bridge = target.bridge;
          work.admitted();
          watchSession(target, work);
          await new Promise<void>((resolve, reject) => {
            const upstream = httpRequest(
              {
                host: "localhost",
                port: target.port,
                path: req.url,
                method: req.method,
                headers: {
                  ...headers(req.headers),
                  host: new URL(target.route.origin).host,
                  connection: "close",
                },
                createConnection: () => target.bridge,
                maxHeaderSize: 32768,
              },
              (incoming) => {
                res.writeHead(incoming.statusCode ?? 502, {
                  ...headers(incoming.headers, true),
                  "x-jetski-stream-id": target.id,
                });
                void pipeline(incoming, res).then(resolve, reject);
              },
            );
            const stop = () => upstream.destroy(Error("Preview interrupted"));
            work!.abort.signal.addEventListener("abort", stop, { once: true });
            upstream.once("close", () =>
              work!.abort.signal.removeEventListener("abort", stop),
            );
            upstream.on("error", reject);
            upstream.on("upgrade", (_response, socket) => {
              socket.destroy();
              reject(Error("Unexpected upgrade"));
            });
            let bytes = 0;
            req.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > 64 * 1024 * 1024) stop();
            });
            req.once("error", stop);
            req.pipe(upstream);
          });
          await bridge.completed;
        } catch (error) {
          work?.abort.abort();
          if (!res.headersSent) {
            res.writeHead(error instanceof PreviewError ? error.status : 502, {
              "cache-control": "no-store",
            });
            res.end("Preview unavailable");
          } else res.destroy();
        } finally {
          bridge?.destroy();
          work?.finish();
        }
      })(),
    );
  });
  server.on("upgrade", (req, socket, head) => {
    track(
      (async () => {
        let work: ReturnType<typeof begin> | undefined,
          bridge: HostDuplex | undefined;
        let upgraded = false;
        try {
          work = begin();
          socket.on("error", () => work?.abort.abort());
          socket.once("close", () => {
            if (!upgraded || !socket.readableEnded || !socket.writableEnded)
              work?.abort.abort();
          });
          const key = req.headers["sec-websocket-key"];
          if (
            req.method !== "GET" ||
            req.headers.upgrade?.toLowerCase() !== "websocket" ||
            req.headers["sec-websocket-version"] !== "13" ||
            typeof key !== "string" ||
            Buffer.from(key, "base64").length !== 16 ||
            Buffer.from(key, "base64").toString("base64") !== key ||
            req.headers["transfer-encoding"] !== undefined ||
            (req.headers["content-length"] !== undefined &&
              req.headers["content-length"] !== "0") ||
            head.length > 32768
          )
            throw new PreviewError(400);
          const target = await interruptible(
            prepare(req, work.abort),
            work.abort.signal,
          );
          bridge = target.bridge;
          work.admitted();
          watchSession(target, work);
          await new Promise<void>((resolve, reject) => {
            const upstream = httpRequest({
              host: "localhost",
              port: target.port,
              path: req.url,
              method: "GET",
              headers: {
                ...headers(req.headers),
                host: new URL(target.route.origin).host,
                connection: "Upgrade",
                upgrade: "websocket",
              },
              createConnection: () => target.bridge,
              maxHeaderSize: 32768,
            });
            upstream.on("error", reject);
            upstream.on("response", (response) => {
              response.destroy();
              reject(Error("Upgrade refused"));
            });
            upstream.on("upgrade", (response, remote, remoteHead) => {
              try {
                const expected = createHash("sha1")
                  .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
                  .digest("base64");
                if (
                  response.statusCode !== 101 ||
                  response.headers.upgrade?.toLowerCase() !== "websocket" ||
                  response.headers["sec-websocket-accept"] !== expected ||
                  remoteHead.length > 32768
                )
                  throw Error("Invalid WebSocket response");
                const protocol = response.headers["sec-websocket-protocol"];
                if (
                  protocol &&
                  (typeof protocol !== "string" ||
                    !(req.headers["sec-websocket-protocol"] ?? "")
                      .split(",")
                      .map((value) => value.trim())
                      .includes(protocol))
                )
                  throw Error("Unrequested WebSocket protocol");
                const filtered = headers(response.headers, true);
                filtered.connection = "Upgrade";
                filtered.upgrade = "websocket";
                filtered["x-jetski-stream-id"] = target.id;
                const lines = Object.entries(filtered).flatMap(
                  ([name, value]) =>
                    (Array.isArray(value) ? value : [value]).map(
                      (part) => `${name}: ${part}\r\n`,
                    ),
                );
                socket.write(
                  "HTTP/1.1 101 Switching Protocols\r\n" +
                    lines.join("") +
                    "\r\n",
                );
                upgraded = true;
                if (remoteHead.length) socket.write(remoteHead);
                if (head.length) remote.write(head);
                remote.on("error", () => socket.destroy());
                socket.pipe(remote);
                remote.pipe(socket);
                void target.bridge.completed.then(resolve, reject);
              } catch (error) {
                remote.destroy();
                reject(error);
              }
            });
            upstream.end();
          });
        } catch (error) {
          work?.abort.abort();
          if (!upgraded && socket.writable)
            socket.end(
              `HTTP/1.1 ${error instanceof PreviewError ? error.status : 502} Preview unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
            );
          else socket.destroy();
        } finally {
          bridge?.destroy();
          work?.finish();
        }
      })(),
    );
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.maxConnections = 256;
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 100;
  return {
    server,
    close: async () => {
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      for (const abort of aborters) abort.abort();
      for (const socket of sockets) socket.destroy();
      await closed;
      await Promise.allSettled([...tasks]);
    },
  };
}
