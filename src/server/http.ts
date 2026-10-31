import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { identifier } from "../core/contracts.js";
import type { SandboxManager } from "../core/manager.js";

export type Principal = { owner: string };
export type Authenticate = (
  authorization: string | undefined,
) => Promise<Principal | undefined>;
export function bearerAuthentication(
  tokens: Array<{ owner: string; token: string }>,
): Authenticate {
  if (!tokens.length || tokens.some((item) => item.token.length < 32))
    throw new Error("At least one strong bearer token is required");
  for (const entry of tokens) identifier(entry.owner);
  if (new Set(tokens.map((entry) => entry.token)).size !== tokens.length)
    throw new Error("Duplicate bearer token");
  const entries = tokens.map((item) => ({
    owner: item.owner,
    digest: createHash("sha256").update(item.token).digest(),
  }));
  return async (authorization) => {
    if (!authorization?.startsWith("Bearer ")) return undefined;
    const candidate = createHash("sha256")
      .update(authorization.slice(7))
      .digest();
    let owner: string | undefined;
    for (const entry of entries)
      if (timingSafeEqual(candidate, entry.digest)) owner = entry.owner;
    return owner ? { owner } : undefined;
  };
}
async function body(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Request body exceeds bound");
    chunks.push(chunk);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("JSON object required");
  return parsed as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("String required");
  return value;
}
function send(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}
function fields(input: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new Error("Unknown request field");
}

export function createHttpServer(
  manager: SandboxManager,
  authenticate: Authenticate,
) {
  const server = createServer(async (request, response) => {
    try {
      const principal = await authenticate(request.headers.authorization);
      if (!principal) {
        send(response, 401, { error: "unauthorized" });
        return;
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "v1") {
        send(response, 404, { error: "not_found" });
        return;
      }
      if (
        parts.length === 2 &&
        parts[1] === "capabilities" &&
        request.method === "GET"
      ) {
        send(response, 200, {
          version: 1,
          releaseQualified: false,
          commands: true,
          outputCursors: true,
          fileRead: true,
          fileList: true,
          fileWrite: true,
          pty: false,
          previews: false,
          tcpForwarding: false,
          cancellationScope: "assignment",
        });
        return;
      }
      if (parts[1] !== "sandboxes") {
        send(response, 404, { error: "not_found" });
        return;
      }
      if (parts.length === 2) {
        if (request.method === "GET") {
          send(response, 200, await manager.list(principal.owner));
          return;
        }
        if (request.method === "POST") {
          const input = await body(request);
          fields(input, ["id", "image", "operationId"]);
          const sandbox = await manager.create(
            principal.owner,
            string(input.id),
            string(input.image),
            string(input.operationId),
          );
          send(response, 202, sandbox);
          return;
        }
      }
      const sandboxId = parts[2];
      if (!sandboxId) {
        send(response, 404, { error: "not_found" });
        return;
      }
      const scope = { owner: principal.owner, sandbox: sandboxId };
      const sandbox = await manager.get(scope);
      if (!sandbox) {
        send(response, 404, { error: "not_found" });
        return;
      }
      if (parts.length === 3 && request.method === "DELETE") {
        const input = await body(request);
        fields(input, ["operationId"]);
        send(
          response,
          202,
          await manager.deleteSandbox(scope, string(input.operationId)),
        );
        return;
      }
      if (parts.length === 3 && request.method === "GET") {
        send(response, 200, sandbox);
        return;
      }
      if (
        parts.length === 5 &&
        parts[3] === "operations" &&
        request.method === "GET"
      ) {
        const operation = await manager.operation(scope, string(parts[4]));
        send(
          response,
          operation ? 200 : 404,
          operation ?? { error: "not_found" },
        );
        return;
      }
      if (
        parts.length === 4 &&
        (parts[3] === "stop" || parts[3] === "checkpoint") &&
        request.method === "POST"
      ) {
        const input = await body(request);
        fields(input, ["operationId"]);
        send(
          response,
          202,
          await manager.stop(scope, string(input.operationId), parts[3]),
        );
        return;
      }
      if (
        parts.length === 4 &&
        parts[3] === "resume" &&
        request.method === "POST"
      ) {
        const input = await body(request);
        fields(input, ["operationId"]);
        send(
          response,
          202,
          await manager.resume(scope, string(input.operationId)),
        );
        return;
      }
      if (
        parts.length === 5 &&
        parts[3] === "files" &&
        request.method === "GET"
      ) {
        const path = string(url.searchParams.get("path"));
        const expectedVersion = url.searchParams.get("version") ?? undefined;
        if (parts[4] === "read") {
          send(
            response,
            200,
            await manager.readFile(
              scope,
              path,
              Number(url.searchParams.get("offset") ?? 0),
              Number(url.searchParams.get("bytes") ?? 65536),
              expectedVersion,
            ),
          );
          return;
        }
        if (parts[4] === "list") {
          send(
            response,
            200,
            await manager.listFiles(
              scope,
              path,
              url.searchParams.get("after") ?? "",
              Number(url.searchParams.get("limit") ?? 256),
              expectedVersion,
            ),
          );
          return;
        }
      }
      if (parts[3] === "files" && parts[4] === "uploads") {
        if (parts.length === 5 && request.method === "POST") {
          const input = await body(request);
          fields(input, ["id", "path", "bytes", "sha256", "mode"]);
          if (
            typeof input.bytes !== "number" ||
            (input.mode !== undefined && typeof input.mode !== "number")
          )
            throw Error("Invalid upload metadata");
          send(
            response,
            202,
            await manager.uploads.begin(scope, string(input.id), {
              path: string(input.path),
              bytes: input.bytes,
              sha256: string(input.sha256),
              mode: (input.mode as number | undefined) ?? 0o644,
            }),
          );
          return;
        }
        const uploadId = string(parts[5]);
        if (parts.length === 6 && request.method === "GET") {
          send(response, 200, await manager.uploads.status(scope, uploadId));
          return;
        }
        if (parts.length === 6 && request.method === "PUT") {
          const input = await body(request);
          fields(input, ["offset", "base64", "sha256"]);
          if (typeof input.offset !== "number")
            throw Error("Invalid upload offset");
          send(
            response,
            200,
            await manager.uploads.chunk(
              scope,
              uploadId,
              input.offset,
              string(input.base64),
              string(input.sha256),
            ),
          );
          return;
        }
        if (
          parts.length === 7 &&
          parts[6] === "finish" &&
          request.method === "POST"
        ) {
          fields(await body(request), []);
          send(response, 200, await manager.uploads.finish(scope, uploadId));
          return;
        }
      }
      if (parts[3] === "commands") {
        if (parts.length === 4 && request.method === "POST") {
          const input = await body(request);
          fields(input, ["id", "argv", "cwd", "timeout"]);
          if (
            !Array.isArray(input.argv) ||
            !input.argv.every((arg) => typeof arg === "string")
          )
            throw new Error("argv must be a string array");
          const timeout = input.timeout ?? 120;
          if (typeof timeout !== "number") throw new Error("Invalid timeout");
          send(
            response,
            202,
            await manager.startCommand(
              scope,
              string(input.id),
              input.argv,
              string(input.cwd ?? "/workspace"),
              timeout,
            ),
          );
          return;
        }
        const id = string(parts[4]);
        if (parts.length === 5 && request.method === "GET") {
          send(response, 200, await manager.commandStatus(scope, id));
          return;
        }
        if (
          parts.length === 6 &&
          parts[5] === "output" &&
          request.method === "GET"
        ) {
          const channel = url.searchParams.get("channel") ?? "stdout";
          if (channel !== "stdout" && channel !== "stderr")
            throw new Error("Invalid channel");
          const offset = Number(url.searchParams.get("offset") ?? 0),
            bytes = Number(url.searchParams.get("bytes") ?? 65536);
          if (
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            !Number.isSafeInteger(bytes) ||
            bytes < 1 ||
            bytes > 256 * 1024
          )
            throw new Error("Invalid output range");
          send(
            response,
            200,
            await manager.commandOutput(scope, id, channel, offset, bytes),
          );
          return;
        }
      }
      send(response, 404, { error: "not_found" });
    } catch {
      // Do not expose provider diagnostics, paths, credentials or workload stderr.
      if (!response.headersSent)
        send(response, 400, { error: "request_failed" });
      else response.destroy();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 100;
  return server;
}

/** Scheduler owns progression. Browser connections never drive reconciliation. */
export function startWorker(
  manager: SandboxManager,
  onError: (error: unknown) => void,
  intervalMs = 1000,
): () => Promise<void> {
  let stopped = false,
    running: Promise<void> | undefined;
  const tick = () => {
    if (stopped || running) return;
    running = (async () => {
      for (const owner of await manager.owners()) {
        try {
          await manager.reconcile(owner);
        } catch (error) {
          onError(error);
        }
      }
    })()
      .catch(onError)
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
