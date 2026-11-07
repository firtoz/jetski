import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function sourceCiStatus(runs) {
  if (!runs.length || runs[0].status !== "completed") return "pending";
  return runs[0].conclusion === "success" ? "green" : "failed";
}
async function main() {
  const sha = process.env.SOURCE_SHA;
  assert.match(sha, /^[a-f0-9]{40}$/);
  for (let attempt = 0; attempt < 30; attempt++) {
    const runs = JSON.parse(
      execFileSync(
        "gh",
        [
          "run",
          "list",
          "--repo",
          process.env.GITHUB_REPOSITORY,
          "--workflow",
          "ci.yml",
          "--branch",
          "main",
          "--event",
          "push",
          "--commit",
          sha,
          "--json",
          "status,conclusion",
        ],
        { encoding: "utf8", timeout: 30000 },
      ),
    );
    const state = sourceCiStatus(runs);
    if (state === "green") return;
    assert.notEqual(
      state,
      "failed",
      "Exact main CI failed; publication denied",
    );
    if (attempt < 29)
      await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  throw Error(
    "Exact main CI has not completed green; observe it, do not bypass the gate",
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
