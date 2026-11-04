/** Bounded, deterministic application work, timed inside either runtime.
 * Run in a disposable writable directory: node runtime-workload.mjs DIRECTORY.
 * No cloud effects, external network, credentials, desktop mounts or subprocess shell.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";

const parent = process.argv[2];
assert(parent && path.isAbsolute(parent));
const root = fs.mkdtempSync(path.join(parent, "jetski-workload-"));
const rows = {};
async function stage(name, run) {
  const cpu = process.cpuUsage(),
    started = performance.now();
  const result = await run();
  rows[name] = {
    wallMs: performance.now() - started,
    cpuMicros: process.cpuUsage(cpu),
    result,
  };
}
let server;
try {
  await stage("sha256", () => {
    const bytes = Buffer.alloc(1024 * 1024, 0xa7);
    const hash = createHash("sha256");
    for (let i = 0; i < 128; i++) hash.update(bytes);
    const digest = hash.digest("hex");
    assert.equal(digest.length, 64);
    return { bytes: 128 * bytes.length, digest };
  });
  await stage("metadata", () => {
    for (let i = 0; i < 400; i++)
      fs.writeFileSync(path.join(root, "entry-" + i), "exact\0bytes\n");
    for (let i = 0; i < 400; i++) {
      const file = path.join(root, "entry-" + i);
      assert.equal(fs.statSync(file).size, 12);
      fs.renameSync(file, file + ".moved");
      assert.equal(fs.readFileSync(file + ".moved", "utf8"), "exact\0bytes\n");
      fs.unlinkSync(file + ".moved");
    }
    return { files: 400 };
  });
  await stage("fsync", () => {
    const file = path.join(root, "sync");
    const fd = fs.openSync(file, "wx");
    const bytes = Buffer.alloc(32768, 0x5a);
    try {
      for (let i = 0; i < 32; i++) {
        fs.writeSync(fd, bytes);
        fs.fsyncSync(fd);
      }
    } finally {
      fs.closeSync(fd);
    }
    const read = fs.readFileSync(file);
    assert.equal(read.length, 1048576);
    assert(read.every((byte) => byte === 0x5a));
    return { bytes: read.length, syncs: 32 };
  });
  await stage("subprocess", () => {
    for (let i = 0; i < 30; i++) {
      const child = spawnSync("/bin/sh", ["-c", "printf exact-child-output"], {
        timeout: 5000,
        encoding: "utf8",
        maxBuffer: 4096,
      });
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0);
      assert.equal(child.stdout, "exact-child-output");
    }
    return { children: 30 };
  });
  const payload = Buffer.alloc(32768, 0x3c);
  server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Length": payload.length });
    response.end(payload);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await stage("loopback", async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      for (let i = 0; i < 100; i++) {
        const bytes = await new Promise((resolve, reject) => {
          const request = http.get(
            { host: "127.0.0.1", port, agent, timeout: 5000 },
            (response) => {
              const parts = [];
              response.on("data", (part) => parts.push(part));
              response.on("error", reject);
              response.on("end", () => resolve(Buffer.concat(parts)));
            },
          );
          request.on("timeout", () =>
            request.destroy(Error("loopback timeout")),
          );
          request.on("error", reject);
        });
        assert(bytes.equals(payload));
      }
    } finally {
      agent.destroy();
    }
    return { requests: 100, bytes: 100 * payload.length };
  });
  console.log(
    JSON.stringify({
      version: 1,
      sample: randomUUID(),
      node: process.version,
      rows,
      maxRssKiB: process.resourceUsage().maxRSS,
    }),
  );
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true });
}
