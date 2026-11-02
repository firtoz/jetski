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

| Gate                      | Work and required evidence                                                                                                                     | Status                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Explain baseline          | Separate capture/compression, range transport, verification, publication, synchronization and removal costs; record request counts and overlap | Host phases, storage/provider counts and differing controller compositions measured.                                                          |
| Incremental granularity   | Evaluate smaller independent frames and packing; preserve old archives and bounded reconstruction                                              | 256 KiB capture members and 8 MiB packs selected; legacy 4 MiB reads and adaptive gzip qualified.                                             |
| Save pipeline             | Carry bounded batching/concurrency and remove redundant round trips without weakening publication proof or uncertain-outcome handling          | Bounded pipeline implemented; pooled save/cycle medians improve; consistent warm parity remains unproven.                                     |
| Cold import               | Evaluate larger/batched or streamed transfers with durable progress, bounded memory and exact idempotent replay after interruption             | Optional16 MiB raw import qualified locally and on fresh hosts; exact source-deleted recovery, progress and cleanup pass.                     |
| Fault qualification       | Corruption, short transfer, lost ACK, restart, cancellation, stale generations, old-format restore and GC/publication races on local/S3 paths  | 257 TypeScript/51 affected Python checks and current seven-job CI pass; valid prior fault evidence reused.                                    |
| Matched hosted comparison | Freeze candidate; ten trials per arm across replicated hosts with identical resources/image/workload and independent filesystem checks         | Current ten-per-arm matrix has all20 exact; pooled medians improve, but host-pair reversal and readiness tie leave consistent parity open.    |
| Large restore/replacement | Compare a larger generic fixture, real source-deleted replacement and interrupted-transfer recovery                                            | Previous raw/cold recovery and repeated saves pass; new forward-only restore needs current larger replacement evidence.                       |
| Downstream adoption       | Pinned artifact, scoped staging save/resume/replacement, preserved existing checkpoints, owned cleanup and exact-SHA CI                        | Verified: pinned deployment, real draft PR, exact warm/source-deleted recovery, three-turn session continuity, fresh coding task and cleanup. |

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

Both installed downstream consumers exactly match qualification32. The entire
pinned client CI passes, and actual staging revision/configuration match the
successful deployment. A fresh physical host restored the previously acknowledged
workspace; real README inspection/edit and a reviewed README-only draft PR now
complete. Independent provider metadata confirms the draft, its exact commit,
one changed file and one added line. Server-owned cleanup durably saved and
stopped it. Warm and source-deleted physical replacement both match the complete
147-entry/322,777,337-byte filesystem. Saved command output and all three user
turns survive; the fresh task's actual tool results confirm the marker, published
commit and clean Git status. Final save and owned cleanup pass; provider inventory
is empty. This downstream gate is closed. Do not repeat completed functional
checks, idle adoption or active immutable-bundle upgrades without a concrete change.

A further local driver correction separates host-owned command-status observation
from full pool reconciliation and its extra immediate status poll. Six regression
checks pass; this correction is not included in the frozen timings above and does
not establish a runtime speedup. Preserve those rows unchanged. The larger cold
worker and integrity-bound fixture plan are prepared with bounded per-action
timings and no extra host requests. Finish the corrected warm comparison and
larger cold comparison on the same two fresh host pairs, reusing retained source
archives. For the second pair, preserve the first pair's acknowledged history and
explicitly select the original retained root; never rewind metadata to an older
backup. This combines the remaining performance work into four fresh hosts. The first
pair is admitted. Two pre-allocation setup failures were preserved and corrected:
route readiness and a retained-root metadata assertion. Empty transactional state
and zero active hosts were confirmed before controller cleanup; neither attempt
consumed a host start. Current journals and recovery details remain private.

Private receipts retain failed attempts, operation identities, current job handles,
provider cleanup and conservative budget accounting. The prior77 accounted performance
hosts were confirmed absent before admission; the first combined candidate host
is now allocated. Four final combined cold/warm starts are reserved within the
existing approved aggregate cap, existing wallet only. Conservative repricing
uses confirmed retired lifetimes and historical zero-compute observations; no
refund, included-start discount or future lifetime saving is assumed. Other
reservations and real-grace fixtures remain untouched. No production cutover.

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
