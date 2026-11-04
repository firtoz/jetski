/** Controlled HTTPS workload inside a sandbox. Configuration is a private file,
 * never URL-bearing argv or console output. Use only owned fixture objects.
 * Checks exact bytes and publishes a downloaded file only after hash + fsync.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

async function main() {
  const file = process.argv[2];
  assert(file?.startsWith("/workspace/") && !file.includes(".."));
  assert(fs.statSync(file).size <= 65536);
  const plan = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const key of ["healthUrl", "downloadUrl", "uploadUrl"]) {
    const url = new URL(plan[key]);
    assert(
      url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.hash &&
        url.href.length <= 8192,
    );
  }
  assert(/^[a-f0-9]{64}$/.test(plan.downloadSha256));
  assert(
    Number.isInteger(plan.downloadBytes) &&
      plan.downloadBytes > 0 &&
      plan.downloadBytes <= 8 * 1024 * 1024,
  );
  assert(
    Number.isInteger(plan.uploadBytes) &&
      plan.uploadBytes > 0 &&
      plan.uploadBytes <= 8 * 1024 * 1024,
  );
  assert(
    Number.isInteger(plan.uploadCharacter) &&
      plan.uploadCharacter >= 0 &&
      plan.uploadCharacter <= 255,
  );
  assert(/^[a-zA-Z0-9_-]{1,128}$/.test(plan.sample));
  const deadline = () => AbortSignal.timeout(20000);
  async function body(response, maximum) {
    assert.equal(response.status, 200);
    const parts = [];
    let size = 0;
    for await (const part of response.body) {
      size += part.length;
      assert(size <= maximum);
      parts.push(part);
    }
    return Buffer.concat(parts);
  }
  let stage = "dns";
  try {
    const cpu = process.cpuUsage(),
      started = performance.now();
    const dnsStarted = performance.now(),
      addresses = await dns.lookup(new URL(plan.healthUrl).hostname, {
        family: 4,
        all: true,
      });
    assert(addresses.length > 0);
    const dnsMs = performance.now() - dnsStarted;
    stage = "latency";
    const latencyMs = [];
    for (let i = 0; i < 10; i++) {
      const before = performance.now();
      const response = await fetch(plan.healthUrl, {
        signal: deadline(),
        redirect: "error",
      });
      assert.equal(
        (await body(response, 4096)).toString(),
        "exact network fixture\n",
      );
      latencyMs.push(performance.now() - before);
    }
    stage = "download";
    const downloadStarted = performance.now();
    const response = await fetch(plan.downloadUrl, {
      signal: deadline(),
      redirect: "error",
    });
    assert.equal(response.status, 200);
    const target = "/workspace/network-download.bin",
      temporary = "/workspace/.network-" + plan.sample + ".part";
    const fd = fs.openSync(temporary, "wx", 0o600),
      hash = createHash("sha256");
    let bytes = 0;
    try {
      for await (const part of response.body) {
        bytes += part.length;
        assert(bytes <= plan.downloadBytes);
        hash.update(part);
        let offset = 0;
        while (offset < part.length) {
          const wrote = fs.writeSync(fd, part, offset);
          assert(wrote > 0);
          offset += wrote;
        }
      }
      assert.equal(bytes, plan.downloadBytes);
      assert.equal(hash.digest("hex"), plan.downloadSha256);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Publish without replacing existing user bytes, even if another process
    // creates the target after our download started. Both paths share a directory.
    fs.linkSync(temporary, target);
    fs.unlinkSync(temporary);
    const directory = fs.openSync(path.dirname(target), "r");
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
    const downloadMs = performance.now() - downloadStarted;
    const upload = Buffer.alloc(plan.uploadBytes, plan.uploadCharacter),
      uploadSha256 = createHash("sha256").update(upload).digest("hex");
    stage = "upload";
    const uploadStarted = performance.now();
    const put = await fetch(plan.uploadUrl, {
      method: "PUT",
      body: upload,
      headers: { "If-None-Match": "*" },
      signal: deadline(),
      redirect: "error",
    });
    assert.equal(put.status, 200);
    if (put.body) await body(put, 4096);
    const uploadMs = performance.now() - uploadStarted;
    console.log(
      JSON.stringify({
        version: 1,
        sample: plan.sample,
        dnsMs,
        latencyMs,
        downloadMs,
        downloadBytes: bytes,
        downloadSha256: plan.downloadSha256,
        uploadMs,
        uploadBytes: upload.length,
        uploadSha256,
        cpuMicros: process.cpuUsage(cpu),
        wholeMs: performance.now() - started,
      }),
    );
  } catch (error) {
    // Signed capability URLs and response bodies must stay out of diagnostics.
    console.error(
      JSON.stringify({
        stage,
        failed: true,
        errorType: error?.name ?? "Error",
      }),
    );
    process.exitCode = 1;
  }
}
main().catch(() => {
  console.error(JSON.stringify({ stage: "configuration", failed: true }));
  process.exitCode = 1;
});
