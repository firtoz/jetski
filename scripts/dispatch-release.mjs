import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const repo = process.env.GITHUB_REPOSITORY;
const sha = process.env.SOURCE_SHA;
const tag = process.env.TAG;
assert.match(repo, /^[\w.-]+\/[\w.-]+$/);
assert.match(sha, /^[a-f0-9]{40}$/);
const pkg = JSON.parse(await readFile("package.json"));
assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
assert.equal(tag, `v${pkg.version}`);
const gh = (args) =>
  execFileSync("gh", args, { encoding: "utf8", timeout: 30000 });
const path = `repos/${repo}/git/ref/tags/${tag}`;
const existing = spawnSync("gh", ["api", path], {
  encoding: "utf8",
  timeout: 30000,
});
if (existing.status === 0) {
  let object = JSON.parse(existing.stdout).object;
  for (let depth = 0; object.type === "tag" && depth < 4; depth++) {
    object = JSON.parse(
      gh(["api", `repos/${repo}/git/tags/${object.sha}`]),
    ).object;
  }
  assert(
    object.type === "commit" && object.sha === sha,
    "Existing tag differs; never overwrite it",
  );
} else {
  assert(
    !existing.error && /HTTP 404/.test(existing.stderr),
    "Uncertain tag lookup; do not create blindly",
  );
  gh([
    "api",
    "--method",
    "POST",
    `repos/${repo}/git/refs`,
    "-f",
    `ref=refs/tags/${tag}`,
    "-f",
    `sha=${sha}`,
  ]);
}
// A dispatch uses the tag as workflow ref, so npm provenance attests the exact
// tested source commit, rather than workflow_run's possibly newer default HEAD.
const runs = JSON.parse(
  gh([
    "run",
    "list",
    "--repo",
    repo,
    "--workflow",
    "release.yml",
    "--commit",
    sha,
    "--limit",
    "100",
    "--json",
    "headBranch,databaseId,status,conclusion",
  ]),
);
if (runs.some((run) => run.headBranch === tag)) {
  console.log(
    "Existing release run observed; use its recovery inputs if necessary, never blindly dispatch again",
  );
} else {
  gh([
    "workflow",
    "run",
    "release.yml",
    "--repo",
    repo,
    "--ref",
    tag,
    "-f",
    `tag=${tag}`,
  ]);
  console.log(
    `Dispatched immutable ${tag} publication after merged Release PR and green main CI`,
  );
}
