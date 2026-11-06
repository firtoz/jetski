import { randomBytes, timingSafeEqual } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";

export type Panel = "source" | "a" | "b";
export type PanelPhase =
  | "waiting"
  | "loading"
  | "live"
  | "frozen"
  | "complete"
  | "failed";
export type TimelineEvent = {
  sequence: number;
  elapsedMs: number;
  panel: Panel;
  phase: PanelPhase;
  message: string;
  desktopUrl?: string;
  snapshotUrl?: string;
};

/** Local presentation only. The driver publishes observations after real effects;
 * this server cannot provision hosts, execute commands or replay lifecycle work. */
export async function openTimeline(receiptFile: string) {
  const token = randomBytes(32).toString("base64url");
  const cookie = "jetski_demo=" + token;
  const events: TimelineEvent[] = [];
  const viewers = new Set<ServerResponse>();
  const snapshots = new Map<string, Uint8Array>();
  let origin: number | undefined;
  const html = await readFile(new URL("dashboard.html", import.meta.url));
  const equal = (value: string | undefined, expected: string) => {
    const actual = Buffer.from(value ?? "");
    const wanted = Buffer.from(expected);
    return actual.length === wanted.length && timingSafeEqual(actual, wanted);
  };
  const server = createServer((request, response) => {
    const address = server.address();
    if (
      !address ||
      typeof address === "string" ||
      !["127.0.0.1:" + address.port, "localhost:" + address.port].includes(
        request.headers.host ?? "",
      )
    ) {
      response.writeHead(403).end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (
      url.pathname === "/" &&
      equal(url.searchParams.get("token") ?? undefined, token)
    ) {
      response
        .writeHead(303, {
          Location: "/",
          "Set-Cookie": cookie + "; HttpOnly; SameSite=Strict; Path=/",
        })
        .end();
      return;
    }
    if (
      !(request.headers.cookie ?? "")
        .split("; ")
        .some((value) => equal(value, cookie))
    ) {
      response
        .writeHead(401)
        .end("Open the private dashboard connection link.");
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    const snapshot = snapshots.get(url.pathname);
    if (snapshot) {
      response.writeHead(200, { "Content-Type": "image/png" }).end(snapshot);
      return;
    }
    if (url.pathname === "/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
      });
      const after = Number(request.headers["last-event-id"] ?? 0);
      for (const event of events)
        if (event.sequence > after) send(response, event);
      viewers.add(response);
      request.once("close", () => viewers.delete(response));
      return;
    }
    if (url.pathname === "/")
      response
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(html);
    else response.writeHead(404).end();
  });
  const send = (response: ServerResponse, event: TimelineEvent) => {
    if (response.writableLength > 1024 * 1024) {
      viewers.delete(response);
      response.destroy();
      return;
    }
    response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  let tail = Promise.resolve();
  const publish = (input: Omit<TimelineEvent, "sequence" | "elapsedMs">) => {
    // Serialize durable append and broadcast so concurrent branches keep one clock/order.
    const next = tail.then(async () => {
      if (input.desktopUrl) {
        const url = new URL(input.desktopUrl);
        if (
          url.protocol !== "http:" ||
          !["127.0.0.1", "localhost"].includes(url.hostname)
        )
          throw Error("Desktop previews must use local authenticated tunnels");
      }
      origin ??= performance.now();
      const event: TimelineEvent = {
        ...input,
        sequence: events.length + 1,
        elapsedMs: performance.now() - origin,
      };
      await appendFile(receiptFile, JSON.stringify(event) + "\n", {
        mode: 0o600,
        flush: true,
      });
      events.push(event);
      for (const response of viewers) send(response, event);
    });
    tail = next;
    return next;
  };
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Dashboard listener unavailable");
  return {
    url: `http://127.0.0.1:${address.port}/?token=${token}`,
    publish,
    get startedAtMs() {
      return origin;
    },
    snapshot(panel: Panel, bytes: Uint8Array) {
      if (
        bytes.length > 10 * 1024 * 1024 ||
        Buffer.from(bytes.subarray(0, 8)).toString("hex") !== "89504e470d0a1a0a"
      )
        throw Error("Invalid desktop PNG");
      const path = "/snapshots/" + panel + ".png";
      snapshots.set(path, new Uint8Array(bytes));
      return path;
    },
    async close() {
      await tail;
      for (const response of viewers) response.end();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
