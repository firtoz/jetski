import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const p = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url)),
);
const { RELEASE_VERSION } = await import("../dist/version.js");
assert.equal(p.version, RELEASE_VERSION);
assert.equal(p.private, false);
assert.match(p.version, /^\d+\.\d+\.\d+$/);
for (const path of Object.values(p.exports)) {
  assert.ok((await readFile(new URL("../" + path, import.meta.url))).length);
  assert.ok(
    (
      await readFile(
        new URL("../" + path.replace(/\.js$/, ".d.ts"), import.meta.url),
      )
    ).length,
  );
}
for (const path of [
  "LICENSE",
  "NOTICE",
  "dist/cli.js",
  "dist/host-assets.js",
  "docs/openapi.json",
])
  assert.ok((await readFile(new URL("../" + path, import.meta.url))).length);
for (const name of await readdir(new URL("../dist/", import.meta.url)))
  assert.ok(!/\.env|\.sqlite|\.pem|npmrc/.test(name));
console.log(`Release structure verified: ${p.name}@${p.version}`);
