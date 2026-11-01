import type { HostConnection } from "../core/host-stream.js";
import { previewHeaders } from "./http-forward.js";
import { readHttpUpgrade } from "./http-response.js";

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export async function websocketAccept(key: string): Promise<string> {
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key) || btoa(atob(key)) !== key)
    throw Error("Invalid WebSocket key");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-1", new TextEncoder().encode(key + GUID)),
  );
  return btoa(String.fromCharCode(...digest));
}

/** Client-side handshake over one authorized host connection. Does not implement
 * frame handling or authenticate a browser. Compression/extensions are disabled.
 * Request cancellation remains attached for the upgraded connection's lifetime. */
export async function upgradeWebSocket(
  connection: HostConnection,
  request: Request,
) {
  const deadline = new AbortController();
  const signal = AbortSignal.any([request.signal, deadline.signal]);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    connection.abort();
  };
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(
    () => deadline.abort(Error("WebSocket handshake timed out")),
    30000,
  );
  const cleanup = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  };
  void connection.completed.then(cleanup, cleanup);
  const wait = async <T>(work: Promise<T>): Promise<T> => {
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
  };
  try {
    signal.throwIfAborted();
    if (
      request.method !== "GET" ||
      request.body ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket"
    )
      throw Error("Invalid WebSocket request");
    const rawProtocols = request.headers.get("sec-websocket-protocol");
    const protocols =
      rawProtocols === null
        ? []
        : rawProtocols.split(",").map((value) => value.trim());
    if (
      protocols.length > 32 ||
      protocols.some((value) => !TOKEN.test(value)) ||
      new Set(protocols).size !== protocols.length
    )
      throw Error("Invalid WebSocket protocols");
    const url = new URL(request.url);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw Error("Invalid WebSocket URL");
    const fields: Array<[string, string]> = [];
    request.headers.forEach((value, name) => {
      if (!name.startsWith("sec-websocket-")) fields.push([name, value]);
    });
    const headers = previewHeaders(fields);
    headers.delete("content-length");
    headers.set("host", url.host);
    headers.set("connection", "Upgrade");
    headers.set("upgrade", "websocket");
    headers.set("sec-websocket-version", "13");
    const key = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
    );
    headers.set("sec-websocket-key", key);
    if (protocols.length)
      headers.set("sec-websocket-protocol", protocols.join(", "));
    const lines: string[] = [];
    headers.forEach((value, name) => lines.push(`${name}: ${value}\r\n`));
    const bytes = new TextEncoder().encode(
      `GET ${url.pathname}${url.search} HTTP/1.1\r\n${lines.join("")}\r\n`,
    );
    if (bytes.length > 32768) throw Error("WebSocket headers limit exceeded");
    for (let at = 0; at < bytes.length; at += 16384) {
      signal.throwIfAborted();
      await wait(connection.send(bytes.subarray(at, at + 16384)));
    }
    const parsed = await wait(readHttpUpgrade(connection.output));
    const single = (name: string) => {
      const values = parsed.headers.filter(([key]) => key === name);
      if (values.length > 1) throw Error("Duplicate WebSocket handshake field");
      return values[0]?.[1];
    };
    if (
      single("upgrade")?.toLowerCase() !== "websocket" ||
      !single("connection")
        ?.toLowerCase()
        .split(",")
        .map((s) => s.trim())
        .includes("upgrade") ||
      single("sec-websocket-accept") !== (await websocketAccept(key))
    )
      throw Error("Invalid WebSocket handshake");
    const protocol = single("sec-websocket-protocol");
    if (protocol !== undefined && !protocols.includes(protocol))
      throw Error("Unrequested WebSocket protocol");
    if (single("sec-websocket-extensions") !== undefined)
      throw Error("Unrequested WebSocket extension");
    signal.throwIfAborted();
    clearTimeout(timer);
    const upgraded: HostConnection = {
      output: parsed.output,
      send: (bytes) => connection.send(bytes),
      end: () => connection.end(),
      abort: stop,
      completed: connection.completed,
    };
    return { connection: upgraded, protocol };
  } catch (error) {
    stop();
    cleanup();
    throw error;
  }
}
