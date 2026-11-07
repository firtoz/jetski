import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { checkChangesets } from "./check-changesets.mjs";

export function trustedMainPush(event, repository, eventName = "push") {
  if (typeof repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repository))
    return false;
  return (
    eventName === "push" &&
    event.ref === "refs/heads/main" &&
    !event.deleted &&
    event.repository?.full_name === repository &&
    /^[a-f0-9]{40}$/.test(event.after)
  );
}
export function mergedRelease(prs, repository, sha) {
  return prs.some(
    (pr) =>
      pr.merged_at &&
      pr.merge_commit_sha === sha &&
      pr.base?.ref === "main" &&
      pr.head?.ref === "changeset-release/main" &&
      pr.head.repo?.full_name === repository &&
      pr.user?.login === "github-actions[bot]",
  );
}
export function compareVersions(a, b) {
  const parse = (v) => {
    assert.match(v, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    return v.split(".").map((n) => {
      const value = Number(n);
      assert(Number.isSafeInteger(value));
      return value;
    });
  };
  const x = parse(a),
    y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]);
  return 0;
}
async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH));
  const repo = process.env.GITHUB_REPOSITORY;
  assert(
    trustedMainPush(event, repo, process.env.GITHUB_EVENT_NAME),
    "Only successful owned main-push CI can plan a release",
  );
  const sha = event.after;
  const gh = (path) =>
    JSON.parse(
      execFileSync("gh", ["api", path], { encoding: "utf8", timeout: 30000 }),
    );
  const output = async (values) => {
    for (const [key, value] of Object.entries(values))
      await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  };
  const pkg = JSON.parse(await readFile("package.json"));
  if ((await checkChangesets()).length) {
    const current = gh(`repos/${repo}/git/ref/heads/main`).object.sha;
    await output({ mode: current === sha ? "version" : "none", sha });
    return;
  }
  if (
    !mergedRelease(
      gh(`repos/${repo}/commits/${sha}/pulls?per_page=100`),
      repo,
      sha,
    )
  ) {
    await output({ mode: "none", sha });
    return;
  }
  const version = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`,
    { signal: AbortSignal.timeout(15000) },
  );
  if (version.status === 200) {
    await output({ mode: "none", sha });
    return;
  }
  assert.equal(
    version.status,
    404,
    "Uncertain registry response; never publish blindly",
  );
  const latest = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/latest`,
    { signal: AbortSignal.timeout(15000) },
  );
  assert.equal(latest.status, 200);
  assert(
    compareVersions(pkg.version, (await latest.json()).version) > 0,
    "Refusing an older latest release",
  );
  const changelog = await readFile("CHANGELOG.md", "utf8");
  assert(
    changelog.includes(`\n## ${pkg.version}\n`),
    "Version has no generated release notes",
  );
  await output({ mode: "publish", sha, tag: `v${pkg.version}` });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
