/** Disposable virtual-display demo. Requires Node with WebSocket, Xvfb and Chromium.
 * Run inside an independently isolated container; never mounts a host display.
 * --outer-sandbox-only explicitly disables Chromium's nested sandbox for this
 * trusted local fixture. It is not a recommendation for browsing untrusted pages.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { performance } from "node:perf_hooks";

assert(
  process.argv.includes("--outer-sandbox-only"),
  "Explicit outer-sandbox-only demo consent required",
);
const output = process.argv[2];
assert(output?.startsWith("/workspace/") && !output.includes(".."));
const chromium = fs
  .readdirSync("/ms-playwright")
  .filter((name) => /^chromium-[0-9]+$/.test(name))
  .map((name) => `/ms-playwright/${name}/chrome-linux64/chrome`)
  .find((file) => fs.existsSync(file));
assert(chromium, "Pinned browser image must contain Chromium");
const started = performance.now(),
  children = [];
const page =
  '<!doctype html><meta charset="utf-8"><title>Private sandbox desktop</title><style>body{background:#152235;color:white;font:24px sans-serif}button,input{position:absolute;left:40px;width:240px;height:50px}button{top:40px}input{top:140px}p{position:absolute;top:220px;left:40px}</style><button id="button" onclick="window.clicks=(window.clicks||0)+1;document.querySelector(\'p\').textContent=\'Clicked safely in private display\'">Click inside sandbox</button><input id="input"><p>Separate display, separate files.</p>';
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(page);
});
let socket;
async function child(program, args) {
  const process = spawn(program, args, {
    env: { ...globalThis.process.env, DISPLAY: ":99", HOME: "/workspace" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(process);
  let stderr = "";
  process.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4096);
  });
  await new Promise((resolve, reject) => {
    process.once("spawn", resolve);
    process.once("error", reject);
  });
  return { process, stderr: () => stderr };
}
try {
  await new Promise((resolve) => server.listen(8899, "127.0.0.1", resolve));
  await child("/usr/bin/Xvfb", [
    ":99",
    "-screen",
    "0",
    "1024x768x24",
    "-nolisten",
    "tcp",
    "-ac",
  ]);
  for (let i = 0; !fs.existsSync("/tmp/.X11-unix/X99"); i++) {
    assert(i < 100, "Private display readiness deadline");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const browser = await child(chromium, [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--no-first-run",
    "--user-data-dir=/workspace/browser-profile",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9222",
    "http://127.0.0.1:8899",
  ]);
  let target;
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    if (browser.process.exitCode !== null)
      throw Error("Browser exited: " + browser.stderr());
    try {
      const response = await fetch("http://127.0.0.1:9222/json/list", {
        signal: AbortSignal.timeout(1000),
      });
      const targets = await response.json();
      target = targets.find(
        (t) => t.type === "page" && t.url === "http://127.0.0.1:8899/",
      );
      if (target) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert(target, "Browser readiness deadline");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const pending = new Map();
  let sequence = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const receipt = pending.get(message.id);
    if (!receipt) return;
    pending.delete(message.id);
    if (message.error) receipt.reject(Error(JSON.stringify(message.error)));
    else receipt.resolve(message.result);
  });
  async function command(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error("CDP observation deadline: " + method));
      }, 5000);
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
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  await command("Page.enable");
  // Readiness inspection may repeat. Mouse/key effects are each sent once.
  let ready = false;
  for (let i = 0; i < 100; i++) {
    const result = await command("Runtime.evaluate", {
      expression: '!!document.querySelector("#input")',
      returnByValue: true,
    });
    if (result.result.value) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert(ready, "Fixture page not loaded");
  const inputStarted = performance.now();
  for (const [x, y] of [
    [140, 65],
    [140, 165],
  ]) {
    await command("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await command("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }
  await command("Input.insertText", { text: "exact sandbox input" });
  const proof = await command("Runtime.evaluate", {
    expression:
      '({clicks:window.clicks,text:document.querySelector("#input").value})',
    returnByValue: true,
  });
  assert.deepEqual(proof.result.value, {
    clicks: 1,
    text: "exact sandbox input",
  });
  const shot = await command("Page.captureScreenshot", { format: "png" }),
    bytes = Buffer.from(shot.data, "base64");
  assert(
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  );
  assert(bytes.length < 4 * 1024 * 1024);
  fs.writeFileSync(output, bytes, { flag: "wx" });
  console.log(
    JSON.stringify({
      exact: true,
      privateDisplay: ":99",
      nestedBrowserSandbox: false,
      launchAndCheckMs: performance.now() - started,
      inputAndScreenshotMs: performance.now() - inputStarted,
      screenshotBytes: bytes.length,
      screenshotSha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
} finally {
  socket?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  for (const process of children.reverse()) {
    if (process.exitCode === null) {
      process.kill("SIGTERM");
      let timer;
      try {
        await Promise.race([
          new Promise((resolve) => process.once("exit", resolve)),
          new Promise((resolve) => {
            timer = setTimeout(resolve, 2000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (process.exitCode === null) process.kill("SIGKILL");
    }
  }
}
