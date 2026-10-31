/** Browser bootstrap never embeds a control-plane credential in workload HTML. */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PreviewSessions } from "../core/preview-sessions.js";
import type { PreviewRoute } from "./preview.js";

export const PREVIEW_COOKIE = "__Host-jetski-preview";
const BOOTSTRAP = `(async()=>{
  let token=location.hash.slice(1);
  history.replaceState(null,"",location.pathname);
  window.opener=null;
  if(!/^[a-zA-Z0-9_-]{1,128}\\.[a-f0-9]{64}$/.test(token))throw Error();
  const key="jetski-preview-redemption:"+token.split(".")[0];
  let redemption=sessionStorage.getItem(key);
  if(!redemption){redemption=crypto.randomUUID();sessionStorage.setItem(key,redemption);}
  let response;
  for(let attempt=0;attempt<3;attempt++){
    try{response=await fetch("/.jetski/redeem",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({token,redemption})});if(response.status<500)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  token="";
  if(!response||!response.ok)throw Error();
  location.replace("/");
})().catch(()=>{document.body.textContent="Preview link unavailable. Request a new link.";});`;
const SCRIPT_HASH = createHash("sha256").update(BOOTSTRAP).digest("base64");
export function previewCookie(header: string | undefined): string | undefined {
  if (!header || header.length > 8192) return undefined;
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(PREVIEW_COOKIE + "="));
  if (matches.length !== 1) return undefined;
  return matches[0]!.slice(PREVIEW_COOKIE.length + 1);
}
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
