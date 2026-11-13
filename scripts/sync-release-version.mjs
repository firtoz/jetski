import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const guides = [
  "README.md",
  "docs/README.md",
  "docs/getting-started.md",
  "docs/simple-api.md",
  "docs/compatibility.md",
  "docs/standalone.md",
  "docs/boxd.md",
  "docs/failure-recovery.md",
  "examples/README.md",
];
export async function syncReleaseVersion(root, check = false) {
  const pkg = JSON.parse(await readFile(new URL("package.json", root)));
  assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  const update = async (path, content) => {
    const url = new URL(path, root);
    if (check)
      assert.equal(
        await readFile(url, "utf8"),
        content,
        `Version drift: ${path}`,
      );
    else await writeFile(url, content);
  };
  const updateJson = async (path, value) => {
    if (check)
      assert.deepEqual(
        JSON.parse(await readFile(new URL(path, root))),
        value,
        `Version drift: ${path}`,
      );
    else await update(path, JSON.stringify(value, null, 2) + "\n");
  };
  await update(
    "src/version.ts",
    `// Kept in sync by the release artifact guard.\nexport const RELEASE_VERSION = "${pkg.version}";\n`,
  );
  const api = JSON.parse(await readFile(new URL("docs/openapi.json", root)));
  api.info.version = pkg.version;
  await updateJson("docs/openapi.json", api);
  const lock = JSON.parse(await readFile(new URL("package-lock.json", root)));
  lock.version = pkg.version;
  lock.packages[""].version = pkg.version;
  await updateJson("package-lock.json", lock);
  const documents = [...guides];
  for (const item of await readdir(new URL("examples/", root), {
    withFileTypes: true,
  })) {
    if (!item.isDirectory() || !/^\d\d-/.test(item.name)) continue;
    const path = `examples/${item.name}/package.json`;
    const example = JSON.parse(await readFile(new URL(path, root)));
    assert(example.private && example.dependencies[pkg.name]);
    example.dependencies[pkg.name] = pkg.version;
    await updateJson(path, example);
    documents.push(`examples/${item.name}/README.md`);
  }
  for (const path of documents) {
    const text = await readFile(new URL(path, root), "utf8");
    const next = text
      .replace(/@firtoz\/jetski@\d+\.\d+\.\d+/g, `${pkg.name}@${pkg.version}`)
      .replace(
        /ghcr\.io\/firtoz\/jetski:v\d+\.\d+\.\d+/g,
        `ghcr.io/firtoz/jetski:v${pkg.version}`,
      );
    await update(path, next);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await syncReleaseVersion(
    new URL("../", import.meta.url),
    process.argv.includes("--check"),
  );
}
