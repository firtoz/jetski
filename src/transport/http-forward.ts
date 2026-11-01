import type { HostConnection } from "../core/host-stream.js";
import { readHttpResponse } from "./http-response.js";

const MAX_BODY = 64 * 1024 * 1024;
const MAX_HEAD = 32768;
const HTTP_DEADLINE_MS = 30000;
const encoder = new TextEncoder();
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Preview policy: control-plane credentials and workload cookies never cross
 * this boundary. Callers still authenticate and authorize an isolated origin. */
export function previewHeaders(
  input: Iterable<[string, string]>,
  response = false,
): Headers {
  const fields = [...input];
  const blocked = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
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
  ]);
  for (const [name, value] of fields) {
    if (name.toLowerCase() === "connection") {
      for (const item of value.split(","))
        blocked.add(item.trim().toLowerCase());
    }
  }
  const output = new Headers();
  for (const [rawName, value] of fields) {
    const name = rawName.toLowerCase();
    if (!TOKEN.test(name) || /[\x00-\x08\x0a-\x1f\x7f]/.test(value))
      throw Error("Invalid preview header");
    if (
      !blocked.has(name) &&
      !/^(x-forwarded-|proxy-|sec-fetch-|x-jetski-)/.test(name)
    )
      output.append(name, value);
  }
  if (response) {
    output.set(
      "content-security-policy",
      "sandbox allow-scripts allow-forms allow-same-origin; worker-src 'none'; frame-ancestors 'none'",
    );
    output.set("referrer-policy", "no-referrer");
    output.set("x-content-type-options", "nosniff");
    output.set("cache-control", "no-store");
  }
  return output;
}

/** One already-authorized connection, no retries. No Node socket APIs.
 * Response completion requires the independent host receipt, not merely HTTP EOF.
 * This HTTP-only adapter rejects upgrades; callers own preview origin/session auth. */
export async function forwardHttp(
  connection: HostConnection,
  request: Request,
): Promise<Response> {
  const cancelled = new AbortController();
  const signal = AbortSignal.any([
    cancelled.signal,
    request.signal,
    AbortSignal.timeout(HTTP_DEADLINE_MS),
  ]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let finished = false,
    stopping = false;
  const stop = () => {
    if (finished || stopping) return;
    stopping = true;
    cancelled.abort(Error("Preview forwarding stopped"));
    connection.abort();
    void reader?.cancel().catch(() => {});
  };
  signal.addEventListener("abort", stop, { once: true });
  const wait = async <T>(promise: Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    let rejectAbort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(signal.reason);
      signal.addEventListener("abort", rejectAbort, { once: true });
    });
    try {
      return await Promise.race([promise, cancelled]);
    } finally {
      signal.removeEventListener("abort", rejectAbort);
    }
  };
  const cleanup = () => {
    finished = true;
    signal.removeEventListener("abort", stop);
    reader?.releaseLock();
  };
  void connection.completed.catch(() => {});
  let upload: Promise<void> | undefined;
  try {
    signal.throwIfAborted();
    reader = request.body?.getReader();
    const url = new URL(request.url);
    if (
      !TOKEN.test(request.method) ||
      ["CONNECT", "TRACE"].includes(request.method) ||
      request.headers.has("upgrade")
    )
      throw Error("Unsupported preview HTTP method or upgrade");
    const requestHeaders: Array<[string, string]> = [];
    request.headers.forEach((value, name) =>
      requestHeaders.push([name, value]),
    );
    const headers = previewHeaders(requestHeaders);
    headers.delete("content-length");
    headers.set("host", url.host);
    headers.set("connection", "close");
    if (reader) headers.set("transfer-encoding", "chunked");
    else headers.set("content-length", "0");
    const headerLines: string[] = [];
    headers.forEach((value, name) => headerLines.push(`${name}: ${value}\r\n`));
    const head = encoder.encode(
      `${request.method} ${url.pathname}${url.search} HTTP/1.1\r\n${headerLines.join("")}\r\n`,
    );
    if (head.length > MAX_HEAD)
      throw Error("Preview request headers limit exceeded");
    const send = async (bytes: Uint8Array) => {
      for (let at = 0; at < bytes.length; at += 16384) {
        signal.throwIfAborted();
        await wait(connection.send(bytes.subarray(at, at + 16384)));
      }
    };
    upload = (async () => {
      await send(head);
      let total = 0;
      if (reader) {
        for (;;) {
          const next = await wait(reader.read());
          if (next.done) break;
          total += next.value.length;
          if (total > MAX_BODY)
            throw Error("Preview request body limit exceeded");
          if (!next.value.length) continue;
          await send(encoder.encode(`${next.value.length.toString(16)}\r\n`));
          await send(next.value);
          await send(encoder.encode("\r\n"));
        }
        await send(encoder.encode("0\r\n\r\n"));
      }
      await wait(connection.end());
    })();
    void upload.catch(stop);
    const uploadFailure = upload.then(() => new Promise<never>(() => {}));
    void uploadFailure.catch(() => {});
    async function* output() {
      const iterator = connection.output[Symbol.asyncIterator]();
      for (;;) {
        const next = await wait(Promise.race([iterator.next(), uploadFailure]));
        if (next.done) return;
        yield next.value;
      }
    }
    const parsed = await readHttpResponse(output(), request.method);
    const iterator = parsed.body[Symbol.asyncIterator]();
    const complete = async () => {
      await wait(upload ?? Promise.resolve());
      await wait(connection.completed);
      cleanup();
    };
    const bodyless =
      request.method === "HEAD" ||
      parsed.status === 204 ||
      parsed.status === 304;
    const responseHeaders = previewHeaders(parsed.headers, true);
    if (bodyless) {
      const next = await iterator.next();
      if (!next.done) throw Error("Unexpected preview body");
      await complete();
      return new Response(null, {
        status: parsed.status,
        headers: responseHeaders,
      });
    }
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) {
            await complete();
            controller.close();
          } else controller.enqueue(next.value);
        } catch (error) {
          stop();
          cleanup();
          controller.error(error);
        }
      },
      async cancel() {
        stop();
        await upload?.catch(() => {});
        cleanup();
      },
    });
    return new Response(body, {
      status: parsed.status,
      headers: responseHeaders,
    });
  } catch (error) {
    stop();
    await upload?.catch(() => {});
    cleanup();
    throw error;
  }
}
