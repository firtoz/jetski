import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

test("live qualification preparation is allocation-free and run requires explicit approval", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "jetski-live-guard-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const config = join(parent, "config.json"),
    directory = join(parent, "run");
  await writeFile(
    config,
    JSON.stringify({
      image: `example/linux@sha256:${"a".repeat(64)}`,
      hosts: { kind: "boat", tokenEnv: "JETSKI_MISSING_FIXTURE_TOKEN" },
      storage: { kind: "local" },
    }),
  );
  const environment = { ...process.env };
  delete environment.JETSKI_PAID_QUALIFICATION_APPROVED;
  delete environment.JETSKI_MISSING_FIXTURE_TOKEN;
  const run = (...args: string[]) =>
    promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "examples/qualify-live-boat.ts", ...args],
      { env: environment, timeout: 10000 },
    );
  const prepared = JSON.parse((await run("prepare", directory, config)).stdout);
  assert.equal(prepared.paidHostsStarted, 0);
  const plan = await readFile(join(directory, "plan.json"), "utf8");
  await assert.rejects(
    run("run", directory),
    /Separate paid-host approval required/,
  );
  assert.equal(await readFile(join(directory, "plan.json"), "utf8"), plan);
  await assert.rejects(run("prepare", directory, config), /EEXIST/);
  await assert.rejects(readFile(join(directory, "state.sqlite")), {
    code: "ENOENT",
  });
});
