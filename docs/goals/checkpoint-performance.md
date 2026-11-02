# Checkpoint performance parity

## Objective

Carry the pre-extraction reference's checkpoint optimizations into the independent
library. Target at least reference performance for durable save, warm resume,
cold restore and the complete workload cycle, while preserving modular adapters,
exact filesystem recovery and every publication/fencing guarantee.

Read this file at every continuation and after compaction. Maintain this finite
checklist and the linked benchmark report; keep private receipts outside the repo.

## Baseline and success criteria

Historical baselines and all matched results are consolidated in
[benchmarks](../benchmarks.md). Use the contemporaneous frozen reference, not an
older historical time, for acceptance.

- Primary target: candidate median save/release and complete-cycle times no higher
  than the matched reference, preserving warm-resume performance. Also target cold
  restore parity on a larger generic fixture. Report tails, variance and failures;
  do not select favorable subsets or declare parity from noise.
- Every acknowledged checkpoint must restore exact bytes, modes, symlinks and
  hardlinks after source deletion, including checkpoints written before this work.
- Count payload bytes, storage/provider calls, physical starts and retained compute
  separately. Timing ends at the same verified durability/readiness boundary.
- If a target remains unmet, retain the full objective and report the actual gap;
  passing safety checks alone does not establish performance completion.

## Constraints

- Preserve host, runtime, storage, transactional-state, scheduling and transport
  boundaries. No application-specific imports, formats or public references.
- Preserve full verification, immutable identities, generation fencing, reader/
  writer coordination, pins and fail-closed GC. Do not acknowledge unsynced bytes
  or release a source before durable publication. Drain failed parallel work.
- Existing 4 MiB-frame checkpoints remain readable. New capture defaults must not
  silently reduce the accepted bounds of previously published archives.
- Preserve the separate real-grace fixtures: no clock, reference, generation or
  storage changes to them. Their scheduled qualification continues independently.
- Local qualification first. Hosted work stays within the existing approved
  aggregate experiment allowance, existing wallet only; protect other reservations.
  No top-ups, snapshots, desktop runtime changes, subagents or production cutover.
- Publish validated milestones on main; pin downstream artifacts and drain old
  assignments before changing immutable host assets. No npm publication.

## Finite implementation and acceptance checklist

| Gate                      | Work and required evidence                                                                                                                     | Status                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Explain baseline          | Separate capture/compression, range transport, verification, publication, synchronization and removal costs; record request counts and overlap | Host phases, storage/provider counts and differing controller compositions measured.                                                       |
| Incremental granularity   | Evaluate smaller independent frames and packing; preserve old archives and bounded reconstruction                                              | 256 KiB capture members and 8 MiB packs selected; legacy 4 MiB reads and adaptive gzip qualified.                                          |
| Save pipeline             | Carry bounded batching/concurrency and remove redundant round trips without weakening publication proof or uncertain-outcome handling          | Bounded pipeline implemented; pooled save/cycle medians improve; consistent warm parity remains unproven.                                  |
| Cold import               | Evaluate larger/batched or streamed transfers with durable progress, bounded memory and exact idempotent replay after interruption             | Optional16 MiB raw import qualified locally and on fresh hosts; exact source-deleted recovery, progress and cleanup pass.                  |
| Fault qualification       | Corruption, short transfer, lost ACK, restart, cancellation, stale generations, old-format restore and GC/publication races on local/S3 paths  | 257 TypeScript/51 affected Python checks and current seven-job CI pass; valid prior fault evidence reused.                                 |
| Matched hosted comparison | Freeze candidate; ten trials per arm across replicated hosts with identical resources/image/workload and independent filesystem checks         | Current ten-per-arm matrix has all20 exact; pooled medians improve, but host-pair reversal and readiness tie leave consistent parity open. |
| Large restore/replacement | Compare a larger generic fixture, real source-deleted replacement and interrupted-transfer recovery                                            | Previous raw/cold recovery and repeated saves pass; new forward-only restore needs current larger replacement evidence.                    |
| Downstream adoption       | Pinned artifact, scoped staging save/resume/replacement, preserved existing checkpoints, owned cleanup and exact-SHA CI                        | Pinned deployment and guarded profile adoption pass; real file inspection and single-file edit pass; publication and recovery remain open. |

## Current candidate and evidence

Current runtime `27720c6`, qualification32, includes the bounded save pipeline,
256 KiB independent members in8 MiB packs, optional16 MiB raw import and native
R2 verified-buffer uploads. Restore now hashes, validates and unpacks once into
private staging, applies final metadata and syncs primary inodes once, then
publishes atomically. Cached begin completes readiness without an extra control
call. Eligibility checks do not replace the streamed byte proof. Corrupt
unpublished caches may fall back only with unchanged authority; valid-source I/O
failures and uncertain acknowledgements remain failures. No workload/file/preview
access is admitted before verified ready. Direct prefetch from an unfinished
upload is not implemented and would require the same publication gate.

All257 TypeScript tests,51 affected archive/import/cache/control checks, build,
types, lint and all seven exact-SHA runtime CI jobs pass. The artifact changes
three host modules and their embedded bundle; checkpoint formats and old4 MiB
reads are preserved. Earlier valid lost-ACK, restart, cancellation, stale-generation,
corruption, GC-race and live R2 consistency evidence is reused.

The new frozen comparison has ten observations per arm across two host pairs,
all20 filesystem checks exact and all four hosts/controllers retired. Pooled
candidate/reference median save is7.196/10.3685 s, readiness4.588/4.726 s and
complete cycle16.4735/19.783 s. Sample p95 cycle is21.865/34.636 s. **Consistent
parity remains unproven:** the first pair loses and the second wins sharply;
median paired readiness ratio is1.003. Preserve both pairs and the preceding
qualification31 regression. The observation driver now immediately rechecks
completion after awaited reconciliation; both new replicas include this separate
change. Do not subtract estimated waits from historical rows or attribute pooled
variance to the runtime change. Full results and controller-composition limits
are in [benchmarks](../benchmarks.md).

The previous larger-source pair measures13.664/22.579 s, with exact436,207,724-byte
fixtures and zero verification payload downloads. Previous source-deleted raw
recovery, full byte/mode/link/output comparisons and repeated saves pass. The new
restore code still needs current cold/replacement qualification; earlier timing
is not an exact-build performance result for qualification32.

Both installed downstream consumers exactly match qualification32. Client main
pins it, with root build/types/lint, startup and lock/advisory review passing;
quality/security CI pass and deployment is queued. Last independently verified
staging is qualification31 with unchanged scoped configuration. Require the new
successful Deploy job and actual configuration/SHA receipt before mutations.
Existing real README inspection/edit completed; the old publication is terminal
cancelled without push, and cleanup durably saved generation4 before source expiry.
Resume that saved work and use the prepared fresh publication ID; do not repeat
read/edit jobs. Publication, warm resume and physical source-deleted replacement
remain open. Do not repeat idle adoption or upgrade active immutable bundles.

Private receipts retain failed attempts, operation identities, current job handles,
provider cleanup and conservative budget accounting. All74 accounted performance
hosts are retired; four final staging/recovery starts are reserved within the
unchanged approved aggregate allowance. Other recovery reservations and real-grace
fixtures remain untouched. No production cutover is authorized.

## Execution order

1. Profile the unchanged paths and add targeted fault/performance instrumentation.
   Separate observed counts from hypotheses about latency; do not assume abstraction
   overhead is the cause or that extra I/O is inherently required for safety.
2. Implement the smallest coherent optimizations in the shared layers. Screen
   alternatives locally, including save granularity, batching, verification reuse
   and durable import progress; run affected checks after each change.
3. Reuse passed evidence and prioritize implementation, as requested. Run only
   changed-path checks and the final client workflow; do not repeat broad warm or
   fault matrices without a concrete new concern. Preserve failed attempts and clean
   owned resources. Repeat only affected failed checks or justified comparisons.
4. Integrate the winning reliable candidate in staging and publish measured results.
   Do not promote a faster but less durable path or claim a universal speedup.

The original v1 real-grace gate passed independently; its evidence is in
[implementation.md](../implementation.md). It does not close this performance goal.
