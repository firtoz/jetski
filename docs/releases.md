# Install, upgrade and roll back

Install a versioned prebuilt npm package, GitHub tarball with its SHA256SUMS, or
verified container digest. Registry consumers need no source checkout or compiler.
The CLI is `jetski`; credentials belong in the operator environment/secret store.
[Getting started](getting-started.md) · [Changelog](../CHANGELOG.md).

The newest patch in the current minor line receives fixes; older minor lines have
no backport promise or contractual SLA. In the 0.x line, incompatible API changes
require a minor bump. API `/v1`, host protocol, checkpoint formats and memory
compatibility have separate versions. Read [compatibility](compatibility.md) and
release notes; a matching sandbox name or S3-shaped API does not establish support.

## Upgrade safely

1. Stop new admission, publish relevant checkpoints and take the complete
   [offline backup](operations.md#backup-and-disaster-recovery).
2. Pin and verify the new artifact. Drain old assignments before replacing immutable
   host bundles; retain the old controller for unresolved work.
3. Start exactly one controller. Check health and a disposable workload before
   reopening admission. Preserve the prior artifact and coordinated backup.

Roll back only if the old release accepts every format written since upgrade.
Otherwise stop/fence the new authority and restore a coordinated backup while
explicitly accounting for newer acknowledged data. Never run two authorities or
silently discard post-backup checkpoints. Do not upgrade beneath a retained memory
checkpoint and assume process compatibility.

SQLite uses format 1 (`PRAGMA user_version`); existing format-0 key/value stores
adopt that marker without rewriting records. Unknown newer formats fail closed.
Breaking storage formats require an explicit migrator and restore procedure.
There is no automatic host-runtime updater or downstream application deployment.

For contribution/versioning/publication work, use the
[maintainer release process](../maintainer/release-process.md).
