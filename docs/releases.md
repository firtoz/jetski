# Releases and upgrades

v0.1 is a narrow self-hosted release, not a hosted-compute service or universal
provider certification. See operations.md, SECURITY.md and qualification.md for
supported boundaries. Only the newest patch in the0.1 line receives fixes; there
is no SLA or automatic host-runtime updater. APIs use `/v1`; host-control protocol,
checkpoint manifests and memory compatibility have their own explicit versions.
Do not infer compatibility from an S3-shaped API or a matching sandbox name.

SQLite uses format1 (`PRAGMA user_version`). Existing format0 key/value stores
adopt this marker without rewriting records; unknown newer versions fail closed.
A future breaking format must ship a documented explicit migrator and restore
procedure. In the0.x line, incompatible API changes require a minor bump; bug fixes
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

## Maintainer procedure

1. Update package/version.ts/OpenAPI together, add release notes, run build,
   typecheck, tests, lint, audit and the clean tarball consumer check.
2. Publish main and require exact-source CI success, including disposable host
   and container fixtures. Reuse unchanged hosted evidence; live changes needing
   paid hosts require a separate allowance. Never replace failures with mock proof.
3. Tag that commit `vX.Y.Z`. The release workflow checks the tag, main ancestry and
   successful exact-source CI before publishing. It packs the artifact once, checks
   registry identity on replay, builds an unprivileged linux/amd64 controller image
   with SBOM/provenance and publishes checksums/source/image identities.
4. Npm trusted publishing binds only this repository's `release.yml` and the
   `npm-release` environment. First publication may require the maintainer's local
   2FA session to establish ownership; configure OIDC afterwards. Never commit a
   token or give pull-request jobs publishing credentials. Registry versions are
   immutable; conflicts require investigation, not overwrite or unpublish.
5. Verify installation from the public registry/release and an anonymous image pull.
   GHCR visibility must be public before advertising a public container command.
   A release is not complete merely because an upload succeeded.
