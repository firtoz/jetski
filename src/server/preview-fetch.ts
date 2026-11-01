import { identifier, type Scope } from "../core/contracts.js";
import type { HostConnection } from "../core/host-stream.js";
import type { PreviewSessions } from "../core/preview-sessions.js";
import { forwardHttp } from "../transport/http-forward.js";
import {
  bridgeWebSocket,
  type WebSocketPeer,
} from "../transport/websocket-bridge.js";
import { upgradeWebSocket } from "../transport/websocket-upgrade.js";
import { BOOTSTRAP, PREVIEW_COOKIE, previewCookie } from "./preview-browser.js";

export interface FetchPreviewOptions {
  route: { origin: string; owner: string; sandbox: string; exposure: string };
  controlOrigins: string[];
  /** Optional trusted control origins allowed to embed the preview. */
  frameAncestors?: string[];
  sessions: Pick<PreviewSessions, "authenticate" | "redeem">;
  open(
    scope: Scope,
    exposure: string,
    id: string,
    signal: AbortSignal,
  ): Promise<HostConnection>;
  /** Platform owns creating/accepting the socket and constructing its 101 response. */
  upgrade(
    request: Request,
    protocol: string | undefined,
  ): { peer: WebSocketPeer; response: Response };
}
function origin(value: string) {
  const url = new URL(value);
  if (
    url.origin !== value ||
    !/^[a-zA-Z0-9_.:\[\]-]+$/.test(url.host) ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw Error("Exact isolated HTTPS origin required");
  return url.origin;
}
const authHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cross-origin-opener-policy": "same-origin",
};
function denied(status: number) {
  return new Response("Preview unavailable", { status, headers: authHeaders });
}
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => {});
    signal.throwIfAborted();
  }
  let cancel = () => {};
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
async function input(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw Error("Missing body");
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      request.signal.throwIfAborted();
      const next = await bounded(reader.read(), request.signal);
      if (next.done) break;
      total += next.value.length;
      if (total > 8192) throw Error("Body bound");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "redemption,token"
    )
      throw Error("Invalid body");
    const fields = value as Record<string, unknown>;
    if (
      typeof fields.token !== "string" ||
      typeof fields.redemption !== "string"
    )
      throw Error("Invalid body");
    return { token: fields.token, redemption: fields.redemption };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Cookie-authenticated isolated-origin Fetch gateway. Streams are opened only
 * after session authorization; revalidation failure aborts existing connections.
 * Keep one gateway instance per configured route to retain its admission bound. */
export function createFetchPreviewGateway(options: FetchPreviewOptions) {
  const route = structuredClone(options.route);
  route.origin = origin(route.origin);
  if (
    !options.controlOrigins.length ||
    options.controlOrigins.map(origin).includes(route.origin)
  )
    throw Error("Preview/control origins must be isolated");
  const controls = new Set(options.controlOrigins.map(origin));
  const parents = (options.frameAncestors ?? []).map(origin);
  if (parents.some((parent) => !controls.has(parent)))
    throw Error("Preview frame parent is not a control origin");
  const ancestors = parents.length ? [...new Set(parents)].join(" ") : "'none'";
  identifier(route.owner);
  identifier(route.sandbox);
  identifier(route.exposure);
  const scope = { owner: route.owner, sandbox: route.sandbox },
    binding = { origin: route.origin, exposureId: route.exposure };
  let active = 0;
  return async (
    request: Request,
    context: { waitUntil(work: Promise<void>): void },
  ): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin !== route.origin) return denied(404);
    const incomingOrigin = request.headers.get("origin");
    if (incomingOrigin !== null && incomingOrigin !== route.origin)
      return denied(403);
    if (url.pathname.startsWith("/.jetski/")) {
      if (url.pathname === "/.jetski/bootstrap" && request.method === "GET") {
        const hash = btoa(
          String.fromCharCode(
            ...new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(BOOTSTRAP),
              ),
            ),
          ),
        );
        return new Response(
          `<!doctype html><meta charset="utf-8"><title>Open preview</title><body>Opening preview…<script>${BOOTSTRAP}</script>`,
          {
            headers: {
              ...authHeaders,
              "content-type": "text/html; charset=utf-8",
              "content-security-policy": `default-src 'none'; script-src 'sha256-${hash}'; connect-src 'self'; frame-ancestors ${ancestors}; base-uri 'none'; form-action 'none'`,
            },
          },
        );
      }
      if (url.pathname !== "/.jetski/redeem" || request.method !== "POST")
        return denied(404);
      if (
        incomingOrigin !== route.origin ||
        request.headers.get("content-type")?.split(";")[0] !==
          "application/json"
      )
        return denied(403);
      try {
        const authRequest = new Request(request, {
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
        });
        const value = await input(authRequest);
        const session = await bounded(
          options.sessions.redeem(
            scope,
            binding,
            value.token,
            value.redemption,
          ),
          authRequest.signal,
        );
        request.signal.throwIfAborted();
        const age = Math.floor((session.expiresAt - Date.now()) / 1000);
        if (age <= 0) throw Error("Expired session");
        return new Response(null, {
          status: 204,
          headers: {
            ...authHeaders,
            "set-cookie": `${PREVIEW_COOKIE}=${session.cookie}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`,
          },
        });
      } catch {
        return denied(403);
      }
    }
    const cookie = previewCookie(request.headers.get("cookie") ?? undefined);
    if (!cookie) return denied(401);
    if (active >= 64) return denied(429);
    active++;
    let cleaned = false,
      connection: HostConnection | undefined;
    let interval: ReturnType<typeof setInterval> | undefined,
      expiry: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController(),
      signal = AbortSignal.any([request.signal, controller.signal]);
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      active--;
      clearTimeout(admission);
      clearInterval(interval);
      clearTimeout(expiry);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      connection?.abort();
      cleanup();
    };
    signal.addEventListener("abort", abort, { once: true });
    const admission = setTimeout(
      () => controller.abort(Error("Preview admission timed out")),
      30000,
    );
    try {
      signal.throwIfAborted();
      const session = await bounded(
        options.sessions.authenticate(scope, binding, cookie),
        signal,
      );
      if (
        !session ||
        session.owner !== route.owner ||
        session.expiresAt <= Date.now()
      ) {
        cleanup();
        return denied(401);
      }
      expiry = setTimeout(
        () => controller.abort(Error("Preview expired")),
        Math.max(0, session.expiresAt - Date.now()),
      );
      let checking = false;
      interval = setInterval(() => {
        if (checking || cleaned) return;
        checking = true;
        void bounded(
          options.sessions.authenticate(scope, binding, cookie),
          AbortSignal.any([signal, AbortSignal.timeout(3000)]),
        )
          .then(
            (valid) => {
              if (
                !valid ||
                valid.owner !== session.owner ||
                valid.id !== session.id ||
                valid.expiresAt !== session.expiresAt
              )
                controller.abort(Error("Preview revoked"));
            },
            () => controller.abort(Error("Preview authority unavailable")),
          )
          .finally(() => {
            checking = false;
          });
      }, 1000);
      const opening = options.open(
        scope,
        route.exposure,
        crypto.randomUUID(),
        signal,
      );
      void opening.then(
        (value) => {
          if (signal.aborted) value.abort();
        },
        () => {},
      );
      connection = await bounded(opening, signal);
      clearTimeout(admission);
      void connection.completed.catch(() => {});
      if (signal.aborted) {
        connection.abort();
        signal.throwIfAborted();
      }
      void connection.completed.then(cleanup, () => {
        controller.abort(Error("Preview transport failed"));
        cleanup();
      });
      const scoped = new Request(request, { signal });
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const upgraded = await upgradeWebSocket(connection, scoped);
        // Recheck after a potentially slow handshake before issuing the browser response.
        if (
          !(await bounded(
            options.sessions.authenticate(scope, binding, cookie),
            signal,
          ))
        )
          throw Error("Preview revoked");
        signal.throwIfAborted();
        const platform = options.upgrade(scoped, upgraded.protocol);
        if (platform.response.status !== 101)
          throw Error("Platform upgrade failed");
        context.waitUntil(
          bridgeWebSocket(upgraded.connection, platform.peer, signal)
            .catch(() => {})
            .finally(cleanup),
        );
        return platform.response;
      }
      const response = await forwardHttp(connection, scoped);
      response.headers.set(
        "content-security-policy",
        `sandbox allow-scripts allow-forms allow-same-origin; worker-src 'none'; frame-ancestors ${ancestors}`,
      );
      return response;
    } catch {
      controller.abort(Error("Preview unavailable"));
      cleanup();
      return denied(502);
    }
  };
}
