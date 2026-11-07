# Releases and upgrades

Jetski is a narrow self-hosted release, not a hosted-compute service or universal
provider certification. See operations.md, SECURITY.md and qualification.md for
supported boundaries. Only the newest patch in the current minor line receives fixes; there
is no SLA or automatic host-runtime updater. APIs use `/v1`; host-control protocol,
checkpoint manifests and memory compatibility have their own explicit versions.
Do not infer compatibility from an S3-shaped API or a matching sandbox name.

SQLite uses format1 (`PRAGMA user_version`). Existing format0 key/value stores
adopt this marker without rewriting records; unknown newer versions fail closed.
A future breaking format must ship a documented explicit migrator and restore
procedure. In the 0.x line, incompatible API changes require a minor bump; bug fixes
preserve acknowledged checkpoint interpretation. Do not upgrade runtime versions
under a retained memory checkpoint and assume process compatibility.

## Install and pin

Use the versioned prebuilt npm package, GitHub release tarball plus SHA256SUMS, or
versioned container digest. The CLI executable remains `jetski`. No TypeScript
compiler or source checkout is required by registry consumers. Credentials remain
in the operator's secret manager/environment, outside workload containers.

## Upgrade / rollback

Read release notes, stop admission, publish relevant checkpoints, and take the
complete offline backup in operations.md. Pin the new artifact and verify its
integrity. Start only one controller; verify health and a disposable workload.
Keep the prior artifact and backup. Roll back only when the prior release accepts
all formats written since upgrade; otherwise stop/fence the new controller and
restore the coordinated backup, explicitly accounting for newer acknowledged data.
Never run two authorities or silently discard post-backup checkpoints.

## Automated releases

1. Run `npm run changeset` for a user-facing change, select patch/minor/major,
   describe it, and commit the generated `.changeset/*.md` file with the change.
   Documentation/build-only changes need no release unless their author adds one.
2. After the **main-push CI test jobs pass**, automation maintains a **Release @firtoz/jetski**
   pull request on `changeset-release/main`. Its version script updates package and
   lock versions, runtime/CLI version, OpenAPI, generated release notes, all numbered
   example manifests and current installation guides together. Historical benchmark
   versions stay unchanged. Bot-created release commits get an explicit CI dispatch.
3. Review and **merge the Release PR yourself**. Automation neither approves nor
   merges it. Its passing test jobs reserve an immutable `vX.Y.Z` tag and dispatch
   `release.yml` at that tag. The publisher independently waits for the entire
   exact-commit main-push CI run to finish green before it can publish. An ordinary commit, unmerged
   release branch, fork CI or failed CI cannot authorize automatic publishing.
4. The existing `npm-release` job builds and checks a clean prebuilt package,
   publishes via npm trusted identity, verifies registry integrity, and creates the
   GitHub tarball/checksums plus container digest/SBOM/provenance. Tag-ref dispatch
   preserves the exact tested commit in npm provenance, even if main has advanced.

`npm run check:release-version` rejects version drift in CI. To rehearse versioning,
use a disposable checkout and run `npm run version:release`; it consumes pending
changesets. Do not run it on main just to prepare the automation.

The pending release PR describes an upcoming package; registry examples are runnable
once that version is public. No downstream application is automatically upgraded
or deployed when a library release is published.

## Recovery and boundaries

- npm trust remains bound to this repository's `release.yml` and `npm-release`
  environment. Only that publishing job has an OIDC token; no long-lived npm token
  is required. The PR-maintenance job cannot publish. Actions PR creation must be
  enabled in repository settings; write permissions are scoped to the jobs that
  need them, with explicit CI dispatch because bot pushes do not trigger workflows.
- All formats, host compatibility and real-provider qualification requirements
  still apply. Reuse unchanged hosted evidence; new paid-host tests require their
  own allowance. Never substitute mocked tests for hosted qualification.
- Manual version-tag dispatch remains available for deliberate recovery. The
  publisher independently checks version/tag identity, main ancestry and successful
  exact-commit main-push CI. Existing tags and published versions are never replaced.
- If npm's automated review delays visibility after an upload, wait and dispatch
  the existing tag with `verify_existing=true`. That observes integrity and finishes
  assets without uploading again. An uncertain response is not permission to replay.
- Publication is serialized. Older versions cannot move npm's `latest` backwards.
  Registry and GitHub artifact conflicts require inspection, never overwrite or
  unpublish. A release is not complete merely because an upload succeeded.
- Verify installation from the public registry/release and anonymous image access.
  GHCR visibility must be public before advertising a public container command.
