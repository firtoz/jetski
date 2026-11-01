/** Browser bootstrap never embeds a control-plane credential in workload HTML. */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PreviewSessions } from "../core/preview-sessions.js";
import type { PreviewRoute } from "./preview.js";

import { BOOTSTRAP, PREVIEW_COOKIE } from "./preview-browser.js";

const SCRIPT_HASH = createHash("sha256").update(BOOTSTRAP).digest("base64");
export async function previewAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  route: PreviewRoute,
  sessions: PreviewSessions,
  signal: AbortSignal,
): Promise<boolean> {
  const path = new URL(req.url ?? "/", route.origin).pathname;
  if (!path.startsWith("/.jetski/")) return false;
  res.setHeader("cache-control", "no-store");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("cross-origin-opener-policy", "same-origin");
  if (path === "/.jetski/bootstrap" && req.method === "GET") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader(
      "content-security-policy",
      `default-src 'none'; script-src 'sha256-${SCRIPT_HASH}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    );
    res.end(
      `<!doctype html><meta charset="utf-8"><title>Open preview</title><body>Opening preview…<script>${BOOTSTRAP}</script>`,
    );
    return true;
  }
  if (path !== "/.jetski/redeem" || req.method !== "POST") {
    res.writeHead(404);
    res.end();
    return true;
  }
  if (
    req.headers.origin !== route.origin ||
    req.headers["content-type"]?.split(";")[0] !== "application/json"
  ) {
    res.writeHead(403);
    res.end();
    return true;
  }
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      signal.throwIfAborted();
      size += chunk.length;
      if (size > 8192) throw Error("Bound exceeded");
      chunks.push(Buffer.from(chunk));
    }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => key !== "token" && key !== "redemption")
    )
      throw Error("Invalid body");
    const value = input as Record<string, unknown>;
    if (typeof value.token !== "string" || typeof value.redemption !== "string")
      throw Error("Invalid body");
    signal.throwIfAborted();
    const session = await sessions.redeem(
      { owner: route.owner, sandbox: route.sandbox },
      { exposureId: route.exposure, origin: route.origin },
      value.token,
      value.redemption,
    );
    signal.throwIfAborted();
    const age = Math.floor((session.expiresAt - Date.now()) / 1000);
    if (age <= 0) throw Error("Expired session");
    res.setHeader(
      "set-cookie",
      `${PREVIEW_COOKIE}=${session.cookie}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`,
    );
    res.writeHead(204);
    res.end();
  } catch {
    if (!res.headersSent) res.writeHead(403);
    res.end();
  }
  return true;
}
