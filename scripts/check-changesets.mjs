import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readChangesets } from "@changesets/read";

export async function checkChangesets(root = new URL("../", import.meta.url)) {
  const pkg = JSON.parse(await readFile(new URL("package.json", root)));
  const changesets = await readChangesets(fileURLToPath(root));
  for (const changeset of changesets)
    for (const release of changeset.releases) {
      assert.equal(
        release.name,
        pkg.name,
        `Unknown release package in ${changeset.id}`,
      );
    }
  return changesets;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log(
    `Validated ${(await checkChangesets()).length} pending changesets`,
  );
}
