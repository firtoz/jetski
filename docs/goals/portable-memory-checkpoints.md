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

Workspace `/home/frtn/work/2026/jetski`, main `06c1124` with intended lifecycle
integration changes ready for the next coherent milestone. Private state:
`/home/frtn/.local/state/jetski-qa/portable-memory-20261104/`; read `current.json`
for exact dirty files, receipts and next actions. No hosted controllers or VMs;
zero paid starts. Separate $3/max10small1h allowance is approved. Do not allocate
until a coherent implementation, frozen workload and finite plan exist.

The [portable design](../portable-memory.md) records the format and guarantees.
Foundation CI 41790770471 passed all nine jobs. Its real native mechanism fixture
preserves the 64 MiB changing heap/process, open-file offset/content and exact
filesystem after deleting original image/tree and using fresh inodes/a different
assignment. This is same-machine CI evidence, not R2 or physical-host replacement.
Prior runtime/store/GC qualification and independent fixtures remain read-only.

Implemented: bounded portable manifests/codecs, source capture/reconstruction,
complete composite retained roots and filesystem-copy projection. The new upload
journal uses a stable input hash and separate per-chunk durable object records
instead of repeatedly rewriting a growing manifest. It recovers lost PUT ACKs and
SQLite restarts, verifies reuse, rotates failed create-only IDs and rejects corrupt
source bytes. The publication extension for frame/packed FS transfer keeps one
writer and acknowledges no FS-only intermediate root. Targeted failure cases pass.

Host export now checks frozen lease/runtime/filesystem, persists capture intent,
replays ready receipts and permits rebuilding only an owned unpublished temporary
pack. The private control protocol supports export and bounded reads; the export
manifest has a selectively increased response bound. Local memory sealing checks
the exported image identity; native resume/release cleans derived packs. Portable
compatibility pins actual native helper bytes and logical policy; CPU requirements
come from runsc's saved image, with target CPU-superset validation. Old local seals
and Podman/default paths remain unchanged. These changes are not portable public
lifecycle support yet.

Latest full local pass: 330 TypeScript / 211 Python tests, build/typecheck/lint/Ruff.
The host now has target import/status/chunk/finish/abort operations. It requires
an already verified filesystem with an explicit memory-required barrier, closes
the target fence, validates compatibility, receives immutable encoded objects,
reconstructs and checks complete native files, then records `restoring` before
the one native effect. Lost ACKs are observed; unknown effects stay quarantined.
Only pre-effect abort can authorize an explicit filesystem fallback. Seven new
import tests cover these branches. Derived cache purge is bound to released
assignment ownership; source memory sealing/native resume behavior stays intact.

Native CI 41799356913 passes the production host import journal and compatibility
helper, preserving full heap/process/open-file state after source image/tree deletion
on one CI machine. Eight jobs pass; the general test job has a browser startup
timeout, preserved after one affected retry. No physical/R2 replacement is proved.

The portable control-plane restore journal holds a durable reader across filesystem
and memory transfer, controller restart and native uncertainty. Target offsets and
receipts recover lost chunk/native acknowledgements without repeating native effects;
pre-effect missing/incompatible memory permits only explicit verified FS fallback.
Core suspend options are stable operation inputs; source capture metadata is persisted
before atomic FS+RAM publication. Replacement placement uses the import coordinator
before ordinary create/cache paths, and reports actual process preservation. SDK,
HTTP/OpenAPI and CLI expose opt-in portable saves with injectable codecs. Existing
local RAM and Podman/default behavior remain unchanged. Two lifecycle replacement
fixtures and five journal interruption/fallback cases pass; these use mocked hosts,
not physical RAM recovery. Binary bindings and hosted qualification remain open.

Next actions, in order:

1. Add optional binary memory export/import bindings to avoid routing large images
   through JSON; instrument actual host-direct bytes/requests. Preserve fallback
   control transport and owner/generation confinement.
2. Qualify only affected binary/restart/ACK/fencing paths, then freeze the artifact,
   workload, finite matrix and owned-resource ledger. Do not allocate before this.
3. Run the one finite approved comparison, both physical R2 memory replacements,
   exact recovery/another save, owned cleanup, honest report and final main CI.

Do not call portable memory complete based on native same-machine evidence or unit
tests. All remaining full-goal gates above still apply.
