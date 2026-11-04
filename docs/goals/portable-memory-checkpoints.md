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

| Gate                   | Required evidence                                                                                                                                                                 | Status                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Portable format/design | Versioned bounded manifest, file/chunk hashes and lengths, codec/layout/compatibility identity, matching FS root and fencing/publication contract                                 | Foundation implemented |
| Upload/reconstruction  | Immutable chunks, verified reconstruction, full and compressed modes, unchanged-chunk reuse with bounded self-contained manifests (no unbounded patch chains)                     | Open                   |
| Lifecycle integration  | Core/host/SDK/server capability-gated portable save/resume; durable publication, cross-host filesystem/process restore and honest fallback                                        | Open                   |
| Targeted failures      | Partial upload/lost ACK/controller restart; malformed/corrupt/missing/stale/incompatible images; no dual writers; retained root/GC reachability                                   | Open                   |
| Native portability     | Actual runtime accepts a freshly reconstructed filesystem on another owned compatible host; full heap/process state and open-file offset/content continuity                       | Open                   |
| Frozen comparison      | Same images/resources/durable boundary; raw full, compressed full and independently compressed incremental chunks; small-change and high-change fixtures                          | Open                   |
| R2 replacement         | Delete source before restore; at least full-compressed and incremental retained-history restore on fresh hosts, exact heap/files/links/original output; repeat save after restore | Open                   |
| Closure                | Honest speed/CPU/bytes/requests/retention/cost report, owned resource absence, main publication and terminal exact-SHA CI                                                         | Open                   |

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

## Current state and recovery

Workspace `/home/frtn/work/2026/jetski`, main `47122bd`, clean before this goal.
The previous optional-runtime goal is complete; its thirty samples, two filesystem
replacements and CI remain valid read-only baseline evidence. Its R2 memory image
was NOT portable or uploaded. Local memory seals deliberately bind physical inode/
lease identity and exact host CPU/kernel hashes; portable import needs a distinct
protocol, not weakening that check. Native restore currently waits for all pages.

Private state will be `/home/frtn/.local/state/jetski-qa/portable-memory-20261104/`.
No controllers, jobs or VMs have been launched for this goal. Do not allocate until a frozen implementation/plan exists. Inspect actual private
process/provider/operation state before any resumed hosted work.

The [portable design](../portable-memory.md) records the current contract.
The first source milestone adds a pure TypeScript bounded portable manifest parser,
replaceable identity/gzip chunk codecs with stored/decoded integrity checks and
bounded streaming decompression, and a composite filesystem-memory retained root.
Registry publication verifies all memory objects before committing the combined
root; complete memory reachability survives retirement of an older shared-chunk
root. Filesystem copy intentionally projects files only, preserving its API scope.
The modules remain internal foundations, not exposed portable runtime support.
Host-side capture now reads a sealed image once, verifies whole native-file hashes,
encodes bounded independent chunks, round-trip checks compression and fsyncs a
create-only pack. Reconstruction verifies stored/decoded/file hashes into a new
private staging tree. Short reads, corrupted transfers, changed source trees,
unsafe links, expansion and partial-output replay are covered. Build/typecheck/lint
and 318 TypeScript / 198 Python tests pass; Ruff passes affected files.

A discrete disposable native fixture now tests a real restored process against
fresh persistent-file inodes and a different assignment. It deletes original image
and filesystem trees, reconstructs chunks, compares logical policy/CPU support,
then checks full heap and persistent open-file offset/content continuity. This
fixture is CI mechanism evidence only, not R2 or a physical replacement host.
The generic workload adds explicit low/high change profiles and an open persistent
file; default arguments remain compatible. No desktop C compilation/runtime occurs.
The native effect primitive accepts only a prepared absent target; lifecycle intent
and admission remain the coordinator's responsibility and are not yet integrated.

No hosted runs or paid starts have been made; the separate $3 allowance is approved.
This source milestone is ready for main publication and native CI. Do not advertise
portable recovery until its lifecycle and physical R2 replacement gates pass.

Key native integration findings: current compatibility hashes include physical OCI
paths, lease annotations and cgroup location; portable policy hashing must replace
only those host-specific identities while retaining security/resource/image policy.
Existing archive timestamps are normalized to zero (outside its filesystem
contract). Native open-file restore needs a fresh-filesystem compatibility proof,
not a weakened same-host inode check. Pinned upstream gofer restore reopens saved
filesystem handles and can restore deleted-open files; this is source evidence,
not qualification. Do not advertise portable memory until the real test passes.

Next: inspect the single disposable native fresh-inode fixture result, repairing
only a concrete failure. Then integrate the portable host export/import and durable
save/resume protocol with
the composite root and stable effects journal. Only then freeze/run the approved
finite hosted comparison and source-deleted R2 replacements. Preserve old local
memory seals and old acknowledged roots.
