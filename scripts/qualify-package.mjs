import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(await readFile(new URL("package.json", root)));
const directory = await mkdtemp(join(tmpdir(), "jetski-release-"));
try {
  const result = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
      { cwd: root, encoding: "utf8" },
    ),
  )[0];
  for (const file of result.files) {
    assert.ok(
      !/(^|\/)(\.env[^/]*|\.npmrc|[^/]*\.sqlite[^/]*|[^/]*\.pem|[^/]*\.key|__pycache__|target)(\/|$)/.test(
        file.path,
      ),
      file.path,
    );
    assert.ok(!file.path.startsWith("node_modules/"));
  }
  const consumer = join(directory, "consumer");
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      consumer,
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      join(directory, result.filename),
    ],
    { stdio: "pipe" },
  );
  await writeFile(
    join(consumer, "check.mjs"),
    `import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';const require=createRequire(import.meta.url);for(const name of ${JSON.stringify(Object.keys(pkg.exports).map((k) => pkg.name + k.slice(1)))}){const m=await import(pathToFileURL(require.resolve(name)));if(!Object.keys(m).length)throw Error('Empty export '+name)} console.log('All installed subpath exports load');`,
  );
  execFileSync(process.execPath, [join(consumer, "check.mjs")], {
    stdio: "inherit",
  });
  const cli = join(consumer, "node_modules", ".bin", "jetski");
  assert.equal(
    execFileSync(cli, ["--version"], { encoding: "utf8" }).trim(),
    pkg.version,
  );
  assert.match(
    execFileSync(cli, ["--help"], { encoding: "utf8" }),
    /durable sandboxes/,
  );
  execFileSync(
    cli,
    [
      "check-config",
      "--config",
      new URL("examples/server-boat.json", root).pathname,
    ],
    { stdio: "inherit" },
  );
  console.log(
    JSON.stringify({
      package: pkg.name,
      version: pkg.version,
      files: result.files.length,
      bytes: result.size,
      integrity: result.integrity,
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
