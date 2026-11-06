import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

type Reply = { id?: number; result?: Record<string, unknown>; error?: unknown };

/** Capture a fresh headless browser, never the operator's desktop/profile.
 * Every JPEG uses its actual monotonic capture time; slow frames do not shorten
 * real lifecycle waits. Encoding is separate from the measured choreography. */
export async function recordDashboard(
  executable: string,
  directory: string,
  url: string,
) {
  await mkdir(directory, { mode: 0o700 });
  const profile = join(directory, "profile");
  const browser = spawn(
    executable,
    [
      "--headless=new",
      "--no-first-run",
      "--disable-background-timer-throttling",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--user-data-dir=" + profile,
      "--window-size=1920,1080",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let socket: WebSocket | undefined;
  let stopped = false;
  let failure: Error | undefined;
  let capturing = true;
  let captureTask: Promise<void> | undefined;
  const frames: Array<{ path: string; timestamp: number }> = [];
  const pending = new Map<
    number,
    {
      method: string;
      resolve(value: Record<string, unknown>): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  let next = 1;
  const fail = (error: Error) => {
    failure ??= error;
  };
  browser.once("error", fail);
  browser.once("exit", () => {
    if (!stopped) fail(Error("Recording browser exited unexpectedly"));
  });
  async function stopBrowser() {
    stopped = true;
    capturing = false;
    socket?.close();
    browser.kill("SIGTERM");
    await exited(browser, 5000);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(Error("Recorder closed"));
    }
    pending.clear();
  }
  async function send(method: string, params: Record<string, unknown> = {}) {
    if (!socket || socket.readyState !== WebSocket.OPEN)
      throw Error("Recorder DevTools unavailable");
    const id = next++;
    const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error("Recorder command timed out: " + method));
      }, 30000);
      pending.set(id, { method, resolve, reject, timer });
    });
    socket.send(JSON.stringify({ id, method, params }));
    return reply;
  }
  try {
    const until = performance.now() + 30000;
    let port: number | undefined;
    while (performance.now() < until) {
      if (failure) throw failure;
      try {
        port = Number(
          (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(
            "\n",
          )[0],
        );
        if (port) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!port) throw Error("Recording browser did not start");
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(5000),
    });
    const targets = (await response.json()) as Array<{
      type: string;
      webSocketDebuggerUrl: string;
    }>;
    const target = targets.find((value) => value.type === "page");
    if (!target) throw Error("Recording page unavailable");
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket!.addEventListener("open", () => resolve(), { once: true });
      socket!.addEventListener(
        "error",
        () => reject(Error("Recorder connection failed")),
        { once: true },
      );
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as Reply;
      if (!message.id) return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error)
        request.reject(
          Error(request.method + ": " + JSON.stringify(message.error)),
        );
      else request.resolve(message.result ?? {});
    });
    socket.addEventListener("close", () => {
      if (!stopped) fail(Error("Recorder connection lost"));
    });
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", { url });
    await send("Page.bringToFront");
    // Read-only readiness checks can repeat during navigation; no workload action is replayed.
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = await send("Runtime.evaluate", {
        expression:
          "document.readyState==='complete'&&!!document.querySelector('.panels')",
        returnByValue: true,
      });
      if ((value.result as { value?: unknown } | undefined)?.value === true) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw Error("Dashboard did not load");
    const started = performance.now();
    let bytes = 0;
    async function capture() {
      const reply = await send("Page.captureScreenshot", {
        format: "jpeg",
        quality: 85,
        fromSurface: true,
        optimizeForSpeed: true,
      });
      if (typeof reply.data !== "string") throw Error("Missing captured frame");
      const timestamp = performance.now() / 1000;
      const data = Buffer.from(reply.data, "base64");
      bytes += data.length;
      if (bytes > 4 * 1024 ** 3 || performance.now() - started > 1800000)
        throw Error("Recording exceeded its 4GiB / 30-minute bound");
      const path = `frame-${String(frames.length).padStart(6, "0")}.jpg`;
      await writeFile(join(directory, path), data, { mode: 0o600, flag: "wx" });
      frames.push({ path, timestamp });
    }
    await capture();
    captureTask = (async () => {
      while (capturing) {
        const before = performance.now();
        await capture();
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.max(0, 1000 / 15 - (performance.now() - before)),
          ),
        );
      }
    })().catch(fail);
    return {
      startedAtMs: frames[0]!.timestamp * 1000,
      assertHealthy() {
        if (failure) throw failure;
      },
      async stop(output: string) {
        capturing = false;
        try {
          await captureTask;
          if (failure) throw failure;
          if (frames.length < 2) throw Error("Insufficient recorded frames");
          await writeFile(
            join(directory, "frames.json"),
            JSON.stringify(frames),
            { mode: 0o600 },
          );
          const concat =
            frames
              .map((frame, index) => {
                const nextFrame = frames[index + 1];
                const duration = nextFrame
                  ? Math.max(0.001, nextFrame.timestamp - frame.timestamp)
                  : 1 / 15;
                return `file '${frame.path}'\nduration ${duration.toFixed(6)}\n`;
              })
              .join("") + `file '${frames.at(-1)!.path}'\n`;
          await writeFile(join(directory, "frames.txt"), concat, {
            mode: 0o600,
          });
          await stopBrowser();
          const encode = spawn(
            "ffmpeg",
            [
              "-v",
              "error",
              "-nostdin",
              "-n",
              "-f",
              "concat",
              "-safe",
              "1",
              "-i",
              "frames.txt",
              "-fps_mode",
              "vfr",
              "-c:v",
              "libx264",
              "-preset",
              "fast",
              "-crf",
              "23",
              "-pix_fmt",
              "yuv420p",
              "-movflags",
              "+faststart",
              output,
            ],
            { cwd: directory, stdio: "inherit" },
          );
          await new Promise<void>((resolve, reject) => {
            encode.once("error", reject);
            encode.once("exit", (code) =>
              code === 0 ? resolve() : reject(Error("MP4 encoding failed")),
            );
          });
        } finally {
          await stopBrowser();
        }
      },
      async abort() {
        capturing = false;
        await captureTask;
        await stopBrowser();
      },
    };
  } catch (error) {
    await stopBrowser();
    throw error;
  }
}

async function exited(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
