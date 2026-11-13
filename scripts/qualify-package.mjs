import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
  await mkdir(consumer, { recursive: true });
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
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
      "@types/node@^24.10.0",
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
  const base = {
    target: "ES2023",
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    noEmit: true,
    skipLibCheck: false,
    lib: ["ES2023", "DOM"],
  };
  for (const [name, compilerOptions] of Object.entries({
    node: {
      ...base,
      module: "NodeNext",
      moduleResolution: "NodeNext",
      types: ["node"],
    },
    platform: {
      ...base,
      module: "ESNext",
      moduleResolution: "Bundler",
      types: [],
    },
    worker: {
      ...base,
      module: "ESNext",
      moduleResolution: "Bundler",
      types: [],
    },
  })) {
    await writeFile(
      join(consumer, `${name}.ts`),
      await readFile(new URL(`test/consumers/${name}.ts`, root)),
    );
    await writeFile(
      join(consumer, `tsconfig.${name}.json`),
      JSON.stringify({ compilerOptions, files: [`${name}.ts`] }),
    );
    execFileSync(
      process.execPath,
      [
        new URL("node_modules/typescript/bin/tsc", root).pathname,
        "-p",
        `tsconfig.${name}.json`,
      ],
      { cwd: consumer, stdio: "inherit" },
    );
  }
  const exampleFiles = [];
  for (const entry of await readdir(new URL("examples/", root), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory() || !/^0[1-68]-/.test(entry.name)) continue;
    const destination = join(consumer, "examples", entry.name);
    await mkdir(destination, { recursive: true });
    await writeFile(
      join(destination, "index.ts"),
      await readFile(new URL(`examples/${entry.name}/index.ts`, root)),
    );
    exampleFiles.push(`examples/${entry.name}/index.ts`);
  }
  await writeFile(
    join(consumer, "tsconfig.examples.json"),
    JSON.stringify({
      compilerOptions: {
        ...base,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        types: ["node"],
      },
      files: exampleFiles,
    }),
  );
  execFileSync(
    process.execPath,
    [
      new URL("node_modules/typescript/bin/tsc", root).pathname,
      "-p",
      "tsconfig.examples.json",
    ],
    { cwd: consumer, stdio: "inherit" },
  );
  const { build } = await import("esbuild");
  const bundled = await build({
    absWorkingDir: consumer,
    entryPoints: ["worker.ts"],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    metafile: true,
  });
  for (const input of Object.keys(bundled.metafile.inputs)) {
    assert.ok(
      !/node:|node_modules\/(?:ssh2|@aws-sdk|@boxd-sh)\//.test(input),
      input,
    );
    assert.ok(!/dist\/(?:node|state\/sqlite|providers)\./.test(input), input);
  }
  const platform = await build({
    absWorkingDir: consumer,
    entryPoints: ["platform.ts"],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    metafile: true,
    external: ["node:crypto", "node:path"],
  });
  for (const input of Object.keys(platform.metafile.inputs)) {
    assert.ok(!/node_modules\/(?:ssh2|@aws-sdk|@boxd-sh)\//.test(input), input);
    assert.ok(
      !/dist\/(?:node\.js|state\/sqlite|server\/hosts)/.test(input),
      input,
    );
  }
  console.log(
    "Strict installed NodeNext, Worker/Bundler and platform consumers plus beginner examples passed; portable browser bundle has no Node/provider dependencies",
  );
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
