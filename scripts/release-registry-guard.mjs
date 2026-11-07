import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compareVersions } from "./release-plan.mjs";

const pkg = JSON.parse(await readFile("package.json"));
const response = await fetch(
  `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/latest`,
  { signal: AbortSignal.timeout(15000) },
);
assert.equal(
  response.status,
  200,
  "Cannot establish current registry release; refusing publication",
);
assert(
  compareVersions(pkg.version, (await response.json()).version) > 0,
  "Refusing to move npm latest backwards; inspect the existing release instead",
);
