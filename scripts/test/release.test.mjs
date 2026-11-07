import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { checkChangesets } from "../check-changesets.mjs";
import {
  compareVersions,
  mergedRelease,
  trustedMainPush,
} from "../release-plan.mjs";
import { sourceCiStatus } from "../require-source-ci.mjs";
import { syncReleaseVersion } from "../sync-release-version.mjs";

const repo = "example/project",
  sha = "a".repeat(40);
const event = {
  ref: "refs/heads/main",
  repository: { full_name: repo },
  after: sha,
  deleted: false,
};
test("automation rejects non-main pushes, forks and non-push events", () => {
  assert(trustedMainPush(event, repo));
  for (const change of [
    { ref: "refs/heads/feature" },
    { repository: { full_name: "foreign/fork" } },
    { after: "not-a-sha" },
    { deleted: true },
  ]) {
    assert.equal(trustedMainPush({ ...event, ...change }, repo), false);
  }
  assert.equal(trustedMainPush(event, repo, "pull_request"), false);
  assert.equal(trustedMainPush(event, repo, "workflow_dispatch"), false);
  assert.equal(trustedMainPush({}, repo), false);
  assert.equal(trustedMainPush(event, undefined), false);
});
const pr = {
  merged_at: "2026-11-07T00:00:00Z",
  merge_commit_sha: sha,
  base: { ref: "main" },
  head: { ref: "changeset-release/main", repo: { full_name: repo } },
  user: { login: "github-actions[bot]" },
};
test("ordinary commits, unmerged PRs and foreign release branches cannot publish", () => {
  assert(mergedRelease([pr], repo, sha));
  for (const change of [
    { merged_at: null },
    { merge_commit_sha: "b".repeat(40) },
    { base: { ref: "feature" } },
    { head: { ...pr.head, ref: "ordinary-change" } },
    { head: { ...pr.head, repo: { full_name: "foreign/fork" } } },
    { user: { login: "someone" } },
  ]) {
    assert.equal(mergedRelease([{ ...pr, ...change }], repo, sha), false);
  }
  assert.equal(mergedRelease([], repo, sha), false);
});
test("registry ordering is numeric and rejects non-stable or malformed versions", () => {
  assert.equal(compareVersions("0.2.10", "0.2.9"), 1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  assert.equal(compareVersions("0.2.0", "0.2.1"), -1);
  assert.equal(compareVersions("0.2.1", "0.2.1"), 0);
  for (const v of [
    "0.2.1-beta",
    "v0.2.1",
    "0.02.1",
    "1.2",
    "999999999999999999.0.0",
  ])
    assert.throws(() => compareVersions(v, "0.2.0"));
});
test("one version synchronizes runtime, OpenAPI, lock, guides and all numbered examples", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-version-test-"));
  const root = pathToFileURL(directory + "/");
  const put = async (path, value) => {
    const file = new URL(path, root);
    await mkdir(new URL(".", file), { recursive: true });
    await writeFile(file, value);
  };
  const json = (path, value) => put(path, JSON.stringify(value));
  try {
    await json("package.json", { name: "@firtoz/jetski", version: "0.2.1" });
    await json("package-lock.json", {
      version: "0.2.0",
      packages: {
        "": { version: "0.2.0" },
        "node_modules/other": { version: "7.0.0" },
      },
    });
    await json("docs/openapi.json", {
      info: { title: "API", version: "0.2.0" },
    });
    await put("src/version.ts", "old");
    const docs = [
      "README.md",
      "docs/README.md",
      "docs/getting-started.md",
      "docs/simple-api.md",
      "docs/standalone.md",
      "docs/boxd.md",
      "docs/failure-recovery.md",
      "examples/README.md",
    ];
    for (const path of docs)
      await put(
        path,
        "@firtoz/jetski@0.2.0 ghcr.io/firtoz/jetski:v0.2.0; historical measurement: 0.2.0\n",
      );
    await put("docs/history.md", "Historical 0.2.0 results\n");
    for (const name of ["01-basic", "02-storage"]) {
      await json(`examples/${name}/package.json`, {
        private: true,
        dependencies: { "@firtoz/jetski": "0.2.0", other: "7.0.0" },
      });
      await put(`examples/${name}/README.md`, "@firtoz/jetski@0.2.0\n");
    }
    await syncReleaseVersion(root);
    await syncReleaseVersion(root, true);
    assert.match(
      await readFile(new URL("src/version.ts", root), "utf8"),
      /"0.2.1"/,
    );
    assert.equal(
      JSON.parse(await readFile(new URL("docs/openapi.json", root))).info
        .version,
      "0.2.1",
    );
    const lock = JSON.parse(await readFile(new URL("package-lock.json", root)));
    assert.equal(lock.version, "0.2.1");
    assert.equal(lock.packages[""].version, "0.2.1");
    assert.equal(lock.packages["node_modules/other"].version, "7.0.0");
    assert.match(
      await readFile(new URL("README.md", root), "utf8"),
      /@firtoz\/jetski@0.2.1 ghcr.io\/firtoz\/jetski:v0.2.1; historical measurement: 0.2.0/,
    );
    assert.equal(
      await readFile(new URL("docs/history.md", root), "utf8"),
      "Historical 0.2.0 results\n",
    );
    await json("examples/02-storage/package.json", {
      private: true,
      dependencies: { "@firtoz/jetski": "0.1.0", other: "7.0.0" },
    });
    await assert.rejects(syncReleaseVersion(root, true), /Version drift/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publication waits for the latest exact-source CI and fails closed on red CI", () => {
  assert.equal(sourceCiStatus([]), "pending");
  assert.equal(
    sourceCiStatus([{ status: "in_progress", conclusion: null }]),
    "pending",
  );
  assert.equal(
    sourceCiStatus([{ status: "completed", conclusion: "success" }]),
    "green",
  );
  assert.equal(
    sourceCiStatus([
      { status: "completed", conclusion: "failure" },
      { status: "completed", conclusion: "success" },
    ]),
    "failed",
  );
  assert.equal(
    sourceCiStatus([{ status: "completed", conclusion: "cancelled" }]),
    "failed",
  );
});

test("frontmatter validation permits consumed release branches without requiring git history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jetski-changeset-parse-"));
  const root = pathToFileURL(dir + "/");
  try {
    await mkdir(new URL(".changeset/", root));
    await writeFile(
      new URL("package.json", root),
      JSON.stringify({ name: "@firtoz/jetski" }),
    );
    assert.deepEqual(await checkChangesets(root), []);
    const path = new URL(".changeset/change.md", root);
    await writeFile(
      path,
      '---\n"@firtoz/jetski": patch\n---\n\nFix transfer.\n',
    );
    assert.equal((await checkChangesets(root))[0].releases[0].type, "patch");
    await writeFile(
      path,
      '---\n"another-package": patch\n---\n\nUnknown package.\n',
    );
    await assert.rejects(checkChangesets(root), /Unknown release package/);
    await writeFile(
      path,
      '---\n\n## "@firtoz/jetski": patch\n\nBroken frontmatter',
    );
    await assert.rejects(checkChangesets(root), /frontmatter/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
