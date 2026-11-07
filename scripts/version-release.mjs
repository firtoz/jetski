import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { syncReleaseVersion } from "./sync-release-version.mjs";

const root = new URL("../", import.meta.url);
execFileSync("npm", ["exec", "--", "changeset", "version"], {
  cwd: root,
  stdio: "inherit",
});
await syncReleaseVersion(root);
const pkg = JSON.parse(await readFile(new URL("package.json", root)));
const changelog = await readFile(new URL("CHANGELOG.md", root), "utf8");
const section = changelog.split(`## ${pkg.version}\n`)[1]?.split(/\n## /)[0];
assert(section?.trim(), "Missing generated release notes");
await writeFile(
  new URL("docs/release-notes.md", root),
  `# Jetski ${pkg.version}\n${section.trimEnd()}\n`,
);
// Format the generated documents with the same formatter as CI.
execFileSync(
  "npm",
  [
    "exec",
    "--",
    "biome",
    "format",
    "--write",
    "package.json",
    "package-lock.json",
    "src/version.ts",
    "README.md",
    "docs",
    "CHANGELOG.md",
    "examples",
  ],
  { cwd: root, stdio: "inherit" },
);
