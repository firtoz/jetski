import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

test("packed artifact excludes local/test files and independently imports portable entrypoints", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const exec = promisify(execFile);
  const packed = JSON.parse(
    (
      await exec(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", directory],
        { timeout: 30000 },
      )
    ).stdout,
  ) as { filename: string; files: { path: string }[] }[];
  assert.equal(packed.length, 1);
  const artifact = packed[0]!;
  for (const file of artifact.files) {
    assert.doesNotMatch(
      file.path,
      /__pycache__|\.pyc$|(?:^|\/)\.env|\.sqlite|host\/(?:test_|qualify_|fixtures\/)/,
    );
  }
  assert.ok(
    artifact.files.some((file) => file.path === "host/install_bundle.py"),
  );
  await exec("tar", [
    "-xzf",
    join(directory, artifact.filename),
    "-C",
    directory,
  ]);
  const root = pathToFileURL(join(directory, "package/")).href;
  const source = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    const root = ${JSON.stringify(root)};
    const hook = registerHooks({resolve(specifier, context, next) {
      if (!specifier.startsWith('.') && !specifier.startsWith('file:')) throw Error('Portable import loaded dependency: ' + specifier);
      return next(specifier, context);
    }});
    const core = await import(root + 'dist/core/index.js');
    const sdk = await import(root + 'dist/sdk.js');
    assert.equal(typeof core.SandboxManager, 'function');
    assert.equal(typeof sdk.JetskiClient, 'function');
    hook.deregister();
    const embeddedHook = registerHooks({resolve(specifier, context, next) {
      if (specifier.includes('fs') || specifier.includes('sqlite') || specifier.includes('ssh2') || specifier.includes('@aws-sdk')) throw Error('Embedded bootstrap loaded forbidden dependency: ' + specifier);
      return next(specifier, context);
    }});
    const embedded = await import(root + 'dist/providers/boat-bootstrap-embedded.js');
    assert.equal(typeof embedded.EmbeddedBoatBootstrap, 'function');
    embeddedHook.deregister();
    const { BoatBootstrap } = await import(root + 'dist/providers/boat-bootstrap.js');
    let calls = 0;
    const tx = {get(key) {
      if (key === 'boat-host/bx_package') return 'allocation';
      if (key === 'allocation') return {id:'bx_package',retired:false};
    }, put() {}};
    const state = {transaction: async callback => callback(tx)};
    const api = {call: async () => { calls++; throw Error('Fixture provider boundary'); }};
    await assert.rejects(new BoatBootstrap(state, api, 'pool', ['example/linux@sha256:' + 'a'.repeat(64)]).ensure('bx_package'));
    assert.equal(calls, 1, 'all packaged host sources must load before the stub provider boundary');
  `;
  await exec(process.execPath, ["--input-type=module", "-e", source], {
    cwd: directory,
    timeout: 10000,
  });
});
