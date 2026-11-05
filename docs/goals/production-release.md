# Production self-hosted release

Read and maintain this file on continuation. Deliver a dependable v0.1 self-hosted
release: prebuilt npm package and container, versioned CI releases with integrity
metadata, stable contracts, safe defaults, operational controls, observability,
backup/recovery runbooks, finite release qualification and pinned staging adoption.
Public content remains generic. No hosted-compute service or production client cutover.

User authorized npm publication (jetski, otherwise jet-ski, otherwise @firtoz/jetski),
necessary credentials, implementation and publication on November 5. This supersedes
the original plan's npm-publication exclusion. No separately authorized paid hosts
for this release: reuse unchanged hosted evidence and disposable CI qualification;
request a bounded allowance only if a changed path needs a live paid test. No desktop
runtime changes or protected client/GC data modifications.

## Finite gates

- [x] Audit actual gaps and freeze supported scope/limitations.
- [ ] Prebuilt versioned package/container, clean artifact consumer checks.
- [ ] Tagged release workflow, provenance/integrity and dependency security.
- [x] Controller exclusivity, config validation, bounded admission and health/logging.
- [x] Backup/restore/upgrade/security/support runbooks and quickstart.
- [ ] Build/typecheck/tests/lint, one disposable CI release candidate pass.
- [ ] Main publication, green exact-SHA CI, npm/release artifacts verified externally.
- [ ] Pinned client staging adoption, unchanged data preserved; qualification or exact blocker.

## Recovery context

Workspace /home/frtn/work/2026/jetski main, initial 1d8b79b. Clean starting tree.
Private receipts: /home/frtn/.local/state/jetski-qa/release-20261105/.
Registry lookup: jetski exists (unrelated1.0.1); jet-ski and @firtoz/jetski return404.
404 does not guarantee name acceptance until actual registry admission.
Next: implement packaging and concrete operator gaps, reuse existing tested lifecycle.
Do not expand performance matrices. Keep detailed receipts outside this document.

Implementation candidate: prebuilt jet-ski0.1.0, container/release workflow,
CLI help/version/check-config, fail-closed single-controller lock, format marker,
owner admission and health.350 local tests pass; build/types/lint, production
audit(0 findings) and clean installed artifact pass. Docker is CI-only (local
daemon unavailable; no desktop changes). Npm CLI session is privately authorized
at release-20261105/npmrc; do not print its contents. Name admission still pending.
Next: source CI/container qualification, first registry admission, release/tag/image
publication, configure narrowly bound trusted publishing and client staging adoption.

First candidate bba182c CI42001545252 exposed container-fixture cleanup EACCES
(image UID1000 differs from runner) masking an earlier error; restart probe also
needed bounded readiness observation. Fix only the fixture, preserve failed log,
then reuse all unaffected checks. New-name staged registry request failed400
"Version uniqueness check failed unexpectedly"; not treated as proof of availability
or successful publication. Direct name admission remains pending after green CI.

Registry confirmed E403 jet-ski is too similar to jetski. Use authorized scoped
@firtoz/jetski0.1.0; CLI remainsjetski and storage namespacejetski/v1 is preserved.
All9 jobs passed at5388caf / CI42001976206, including fixed container qualification.
Only package/import documentation metadata is renamed for final source CI.
