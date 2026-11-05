// CI-only Docker daemon. Never starts or installs a runtime on an operator desktop.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.GITHUB_ACTIONS !== "true")
  throw Error("Disposable CI runner required");
const run = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 300000 });
const dir = await mkdtemp(join(tmpdir(), "jetski-container-")),
  name = "jetski-qualify-" + randomUUID(),
  token = randomUUID() + randomUUID();
try {
  await chmod(dir, 0o755);
  await mkdir(join(dir, "data"), { mode: 0o777 });
  await chmod(join(dir, "data"), 0o777);
  const config = {
    dataDirectory: "/data",
    host: "0.0.0.0",
    poolId: "fixture",
    principals: [{ owner: "fixture", tokenEnv: "JETSKI_API_TOKEN" }],
    approvedImages: ["example/linux@sha256:" + "a".repeat(64)],
    hostProvider: {
      kind: "ssh",
      hosts: [
        {
          id: "fixture",
          hostname: "127.0.0.1",
          port: 9,
          user: "fixture",
          privateKeyPath: "/unavailable",
          knownHostsPath: "/unavailable",
        },
      ],
    },
  };
  await writeFile(join(dir, "config.json"), JSON.stringify(config));
  run("build", "-t", name, ".");
  assert.match(run("run", "--rm", name, "--version"), /^0\.1\.0/);
  run(
    "run",
    "-d",
    "--name",
    name,
    "--network",
    "none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "-e",
    `JETSKI_API_TOKEN=${token}`,
    "-v",
    `${dir}/config.json:/etc/jetski/server.json:ro`,
    "-v",
    `${dir}/data:/data`,
    name,
  );
  const health = () => run("exec", name, "node", "healthcheck.mjs");
  const waitReady = async () => {
    for (let i = 0; i < 30; i++) {
      try {
        health();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw Error("Controller did not become ready");
  };
  await waitReady();
  assert.equal(run("exec", name, "id", "-u").trim(), "1000");
  run("stop", "--time", "30", name);
  run("start", name);
  await waitReady();
  run("stop", "--time", "30", name);
  console.log(
    "Unprivileged read-only/network-disabled container starts, probes, stops and restarts without allocating a host",
  );
} catch (error) {
  try {
    console.error(run("logs", name));
  } catch {}
  throw error;
} finally {
  try {
    run("rm", "-f", name);
  } catch {}
  // CI runner and image use different UIDs. Remove only this owned fixture's
  // children as their creating user; never mask the original failure with EACCES.
  try {
    run(
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${dir}/data:/data`,
      "--entrypoint",
      "/bin/sh",
      name,
      "-c",
      "rm -rf /data/*",
    );
  } catch {}
  await rm(dir, { recursive: true, force: true }).catch((error) =>
    console.error("Fixture cleanup failed", error.code),
  );
}
