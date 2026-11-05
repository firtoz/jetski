/** CDP harness restricted to an owned disposable CI browser and fresh profile. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

export async function fixtureBrowser(tls?: { spki: string; hostname: string }) {
  if (
    tls &&
    (!/^[A-Za-z0-9+/]{43}=$/.test(tls.spki) ||
      tls.hostname !== "preview.example")
  )
    throw Error("Invalid fixture TLS boundary");
  if (process.env.GITHUB_ACTIONS !== "true" || !process.env.JETSKI_TEST_CHROME)
    throw Error("disposable_ci_browser_required");
  const directory = await mkdtemp(join(tmpdir(), "jetski-browser-"));
  const child = spawn(
    process.env.JETSKI_TEST_CHROME,
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--remote-debugging-pipe",
      ...(tls
        ? [
            `--ignore-certificate-errors-spki-list=${tls.spki}`,
            `--host-resolver-rules=MAP ${tls.hostname} 127.0.0.1`,
            "--no-proxy-server",
          ]
        : []),
      `--user-data-dir=${directory}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
  );
  let diagnostics = "";
  child.stderr?.on("data", (bytes: Buffer) => {
    diagnostics = (diagnostics + bytes.toString()).slice(-8192);
  });
  let closed = false;
  const stopped = new Promise<void>((resolve) =>
    child.once("close", () => {
      closed = true;
      resolve();
    }),
  );
  const input = child.stdio[3] as Writable;
  const output = child.stdio[4] as Readable;
  let serial = 0,
    buffer = Buffer.alloc(0);
  const pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
    }
  >();
  const fail = () => {
    for (const task of pending.values())
      task.reject(Error("Owned browser stopped"));
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", fail);
  input.on("error", fail);
  output.on("error", fail);
  output.on("data", (bytes: Buffer) => {
    buffer = Buffer.concat([buffer, bytes]);
    if (buffer.length > 10 * 1024 * 1024) {
      fail();
      child.kill();
      return;
    }
    let end: number;
    while ((end = buffer.indexOf(0)) >= 0) {
      const message = JSON.parse(buffer.subarray(0, end).toString());
      buffer = buffer.subarray(end + 1);
      const task = pending.get(message.id);
      if (!task) continue;
      pending.delete(message.id);
      if (message.error) task.reject(Error("Browser protocol request failed"));
      else task.resolve(message.result);
    }
  });
  const call = (
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 15000,
  ): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          Error(
            `Browser request timed out: ${method}; owned browser diagnostics: ${diagnostics.slice(-2048)}`,
          ),
        );
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      input.write(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }) + "\0",
      );
    });
  const close = async () => {
    if (!closed) {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 3000);
      await stopped;
      clearTimeout(force);
    }
    fail();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    // Only cold launch gets a longer bound; workload CDP calls retain 15 seconds.
    const version = await call("Browser.getVersion", {}, undefined, 45000);
    console.log("Disposable browser:", version.product);
    const target = await call("Target.createTarget", { url: "about:blank" });
    const attached = await call("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    assert.equal(typeof attached.sessionId, "string");
    const session = attached.sessionId as string;
    return {
      close,
      call: (method: string, params?: Record<string, unknown>) =>
        call(method, params, session),
      evaluate: async (expression: string) => {
        const result = await call(
          "Runtime.evaluate",
          {
            expression,
            awaitPromise: true,
            returnByValue: true,
            timeout: 12000,
          },
          session,
        );
        assert.equal(
          result.exceptionDetails,
          undefined,
          "Browser expression failed",
        );
        return (result.result as { value: unknown }).value;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
