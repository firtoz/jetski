# Portable durable process-memory checkpoints

## Full objective

Implement optional portable gVisor process-memory checkpoints in independently
replaceable object storage, qualify with R2, compare compression and incremental
chunks, and resume acknowledged process state on a replacement Boat after deleting
the source. Read and maintain `/home/frtn/work/2026/jetski/docs/goals/portable-memory-checkpoints.md`
at the start of every continuation and after compaction; pursue this entire finite
objective. Keep Podman/defaults and current local memory resume working.

Acknowledged recovery points preserve exact process memory and the matching
filesystem bytes/modes/symlinks/hardlinks within the declared checkpoint boundary.
No absolute promise about uncheckpointed writes or external services/sockets.
Publish memory objects and the exact filesystem root atomically through a verified
retained manifest; no success before all required immutable objects are durable.
Memory contains credentials: keep objects owner scoped, access authenticated,
credentials outside workloads and manifests private; never publish raw images.

Keep host provider, runtime, codecs, chunk layout and checkpoint store replaceable.
No R2-specific logic in the portable core, mandatory new service or Agent37
integration. Stable operations, exclusive placement, generation fences, source
quarantine on uncertainty, reader/writer coordination, pins, retained-root accounting
and fail-closed GC remain mandatory. No cross-owner deduplication or reuse.

Cross-host resume needs a portable content proof, not accepting new inode numbers
against the old same-host seal. Pin runtime/image/configuration and validate CPU
features and required host capabilities before native effects. Restore exact files
before RAM; never execute against mismatched files or unchecked chunks. Record
uncertain restore before effects and observe rather than replay. Retain verified
filesystem-only recovery with explicit process-state loss when memory is unusable;
an uncertain source must never be released or start competing writers. Missing,
corrupt, truncated, stale or incompatible artifacts fail closed.

## Finite implementation and acceptance

| Gate                   | Required evidence                                                                                                                                                                 | Status                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Portable format/design | Versioned bounded manifest, file/chunk hashes and lengths, codec/layout/compatibility identity, matching FS root and fencing/publication contract                                 | Passed: bounded format/compatibility tests                 |
| Upload/reconstruction  | Immutable chunks, verified reconstruction, full and compressed modes, unchanged-chunk reuse with bounded self-contained manifests (no unbounded patch chains)                     | Passed: local + live R2 immutable transfer                 |
| Lifecycle integration  | Core/host/SDK/server capability-gated portable save/resume; durable publication, cross-host filesystem/process restore and honest fallback                                        | Passed: optional API + both RAM recoveries                 |
| Targeted failures      | Partial upload/lost ACK/controller restart; malformed/corrupt/missing/stale/incompatible images; no dual writers; retained root/GC reachability                                   | Passed: changed-path restart/ACK/corruption/fencing suites |
| Native portability     | Actual runtime accepts a freshly reconstructed filesystem on another owned compatible host; full heap/process state and open-file offset/content continuity                       | Passed: both compatible physical replacements              |
| Frozen comparison      | Same images/resources/durable boundary; raw full, compressed full and independently compressed incremental chunks; small-change and high-change fixtures                          | Passed: 30 local + 18 hosted samples                       |
| R2 replacement         | Delete source before restore; at least full-compressed and incremental retained-history restore on fresh hosts, exact heap/files/links/original output; repeat save after restore | Passed: both variants + another save                       |
| Closure                | Honest speed/CPU/bytes/requests/retention/cost report, owned resource absence, main publication and terminal exact-SHA CI                                                         | Owned cleanup/report passed; final SHA receipt required    |

Implement coherently with affected tests first; then freeze artifact/config/workload.
One local byte-codec matrix: three modes × two change profiles × five cycles =
thirty samples. One hosted matrix: three modes × two profiles × three cycles =
eighteen samples, six source hosts, plus two planned source-deleted replacements.
Use raw native images as input to portable compression/chunk layouts; compare
native flate as a local codec alternative only if it preserves a comparable
reconstructable input. Evaluate deterministic content-addressed chunks, including
whether native state serialization shifts chunk boundaries. Keep manifests complete
and reuse immutable chunks instead of depending on sequential patch application.

Measure capture/freeze, compression/hash, upload/publication/verification,
reconstruction, native restore and first useful response; actual transferred bytes
including host-direct paths, requests, CPU/memory, full/incremental retained bytes,
host starts/compute and wallet separately. Report cold provisioning separately.
Choose practical defaults from evidence; a tradeoff or no speed win is valid.

Reuse unchanged store/GC/interactive qualification. Add only cases needed for this
new object reachability and restore path. No extra browser/model/PR workflows,
repeated unchanged matrices, lazy remote page execution or scope expansion. Preserve
failed attempts and original IDs; rerun only affected cases after a concrete fix.
If a native portability constraint cannot be solved safely, report it explicitly;
do not substitute filesystem recovery and call it process-memory recovery.

## Authorization and boundaries

Local implementation starts now. Additional paid hosts require a separate allowance
under AGENTS.md. User approved this separate cap on November 4: $3 from
existing Boat wallet, no top-up, at most ten small one-hour hosts (six arms, two
replacements, two failure reserves). Reuse the first source as capability preflight.
Never consume prior experiment/GC reservations or modify their retained fixtures.

No subagents, desktop runtime/toolchain installation, provider snapshots, cross-owner
reuse, default/client/staging/production cutover, npm publication, infrastructure
purchases or wallet top-ups. Public source/docs/fixtures stay generic; credentials,
raw memory and receipts stay private. Session authorization covers coherent main
milestones and final publication; do not import product code/history.

## Final evidence and recovery context

Runtime source `d68c811` on main; first-nine-cycle artifact `940273d` differs only
in the pre-effect parent handoff fix. Codec, storage and warm paths are unchanged.
[The consolidated report](../portable-memory-benchmarks.md) records all measured
results, preserved failures, artifact boundary and compatibility limits.
[API/design guidance](../portable-memory.md) covers explicit opt-in use.

Private completion evidence and exact publication-SHA CI status are maintained at
`/home/frtn/.local/state/jetski-qa/portable-memory-20261104/current.json`.
Its `benchmark/final-audit.json`, `report.json`, `retention.json` and independent
oracles prove eighteen exact hosted cycles, both source-deleted R2 RAM recoveries,
another portable save after each, eight fresh provider 404 checks, no active owned
hosts and no remaining reader/writer admissions. Thirty local codec samples also
matched exactly. Do not rerun these matrices. Check the external exact-SHA receipt
before treating final publication acceptance as complete.

The first incremental replacement required guarded normalization of only the outer
assignment parent under a closed fence and positive native absence. Its complete
persistent filesystem fingerprint stayed unchanged; no host code was hot-patched.
The second full-compressed replacement exercised the automatic fixed path. Both
preserved the full changing 64 MiB heap, process token/counter, open-file cursor
and bytes, files/modes/links and acknowledged original output. The first elapsed
recovery includes diagnosis and is not a clean performance sample.

The response-envelope mismatch and the initial-oracle ordering bug are retained
with original IDs and receipts. The source stayed frozen after the pre-effect
export failure. No unverified native effect was replayed. Native CI now tests the
real parent handoff without its old manual adjustment; source validation passes
334 TypeScript / 215 Python tests, build/typecheck/lint/Ruff and native qualification.
One source CI attempt had an unrelated browser startup timeout; final publication
CI is checked separately, without expanding the functional matrix.

Accounting: eight starts, 2,093 provider-weighted seconds, $0.02093 of included
compute-credit value and $0 observed wallet debit. Reserved $0.848 remains below
the separate $3 allowance; the unsampled compute-value tail is below $0.000008.
No top-up, provider snapshot, production/client cutover or old fixture/budget change.
Acknowledged objects and manifests remain intentionally retained. There are no
remaining runtime experiments or paid allocations planned for this goal.

Final publication checklist: publish the report, usage guidance and concise README
summary; confirm terminal exact-SHA CI and the completion receipt; then close the
existing goal. Do not create a replacement goal or repeat completed qualification.
