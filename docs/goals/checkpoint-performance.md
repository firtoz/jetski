# Checkpoint performance parity

## Objective

Carry the pre-extraction reference's checkpoint optimizations into the independent
library. Target at least reference performance for durable save, warm resume,
cold restore and the complete workload cycle, while preserving modular adapters,
exact filesystem recovery and every publication/fencing guarantee.

Read this file at every continuation and after compaction. Maintain this finite
checklist and the linked benchmark report; keep private receipts outside the repo.

## Baseline and success criteria

The existing equal-resource comparison used ten alternating trials per arm, the
same image and workload, two CPUs and 2 GiB per container. Reference medians were
7.659 s save/release, 4.738 s resume and 17.243 s complete cycle. The candidate
measured 26.966 s, 2.325 s and 30.892 s respectively; see [benchmarks](../benchmarks.md).
New decisions use a freshly measured frozen reference, not those historical numbers
as a substitute for a contemporaneous comparison.

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

| Gate                      | Work and required evidence                                                                                                                     | Status                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Explain baseline          | Separate capture/compression, range transport, verification, publication, synchronization and removal costs; record request counts and overlap | Host phases, storage/provider counts and differing controller compositions measured.                                         |
| Incremental granularity   | Evaluate smaller independent frames and packing; preserve old archives and bounded reconstruction                                              | 1 MiB members and verified packs qualified; legacy 4 MiB reads preserved; adaptive gzip candidate.                           |
| Save pipeline             | Carry bounded batching/concurrency and remove redundant round trips without weakening publication proof or uncertain-outcome handling          | Bounded pipeline implemented; latest warm medians beat reference on both pairs; large save gap and tails remain.             |
| Cold import               | Evaluate larger/batched or streamed transfers with durable progress, bounded memory and exact idempotent replay after interruption             | Optional16 MiB raw import implemented with durable offsets and cleanup; affected local checks pass; live comparison pending. |
| Fault qualification       | Corruption, short transfer, lost ACK, restart, cancellation, stale generations, old-format restore and GC/publication races on local/S3 paths  | 236 TypeScript/124 Python tests, all seven host CI jobs and large source-deleted/lost-ACK recovery pass.                     |
| Matched hosted comparison | Freeze candidate; ten trials per arm across replicated hosts with identical resources/image/workload and independent filesystem checks         | Frozen ten-per-arm comparison completed with all20 exact and lower warm medians on both pairs; tails remain worse.           |
| Large restore/replacement | Compare a larger generic fixture, real source-deleted replacement and interrupted-transfer recovery                                            | Uninterrupted source-deleted large recovery and repeated saves pass; save/cold speed parity remains open.                    |
| Downstream adoption       | Pinned artifact, scoped staging save/resume/replacement, preserved existing checkpoints, owned cleanup and exact-SHA CI                        | New artifact pin and persisted admission profiles implemented; final deployment, scoped workflow and replacement pending.    |

## Current candidate and evidence

The implementation includes immutable compressed frames and physical packs,
bounded transfers, adaptive gzip, durable bulk-import progress, replay-safe host
finalization and persisted command/output proofs. Verified local-cache reuse now
borrows a fenced read-only archive instead of copying it. General capture and
inline-output defaults remain unchanged; the comparison selects256 KiB members,
8 MiB packs and an8192-byte inline threshold. Existing4 MiB archives and older
output formats remain readable. See [standalone.md](../standalone.md) for controls.

The latest transport binds the admitted image to a supervisor-owned immutable
export under `/tmp`, within the host file gateway's permitted boundary. Large
contiguous reads use one bounded stream with ordered pack consumption; sparse
reads retain exact ranges and small deltas avoid authorization setup. No complete
archive is buffered. Redirects, wrong metadata, truncation and excess bytes fail
closed. All source reads settle before stream/export cleanup; frame/object hashes,
remote publication verification and source-retention barriers remain mandatory.

Build, types, lint, the13 focused stream/transport/shutdown checks and all seven
host CI jobs pass at `f02cc84854d0a3cbb4c5a39be967d6b21fd18cca`. Earlier full
fault qualification covers corruption, lost acknowledgements, restart, stale
leases, cancellation, old checkpoints and GC/publication races. Reuse that valid
evidence; repeat only checks affected by a concrete failure or change.

The larger fixture recovered exactly after physical source deletion:18 normalized
entries and436,207,724 logical bytes, including two hardlink groups. Its complete
candidate filesystem and saved command output also matched, and repeated saves
passed. All four machines and temporary controllers are retired. That matched
pre-streaming sample measured52.768 versus17.757 s initial save, and193.631 versus
48.303 s whole replacement readiness; reference data-only restore was21.087 s.
The speed gap remains open. Earlier interrupted attempts and their independent
oracles/archives are preserved separately.

The final frozen ten-per-arm warm comparison has lower candidate median save,
resume and complete-cycle times on both independent host pairs, with all20
filesystem oracles exact. Resume/cycle tails remain worse. The later ordered
multi-pack pipeline's separate full-save sample is25.574 versus16.619 s; the large
speed gap remains open. See [consolidated measurements](../benchmarks.md). Reuse
unaffected warm and fault evidence instead of rerunning the entire matrix for each
changed large-transfer path. Bounded16 MiB binary import is now implemented behind an optional transport
binding, preserving the fenced writer and old control fallback. Targeted import,
transport and old-root checks pass; live raw-import timing remains unmeasured.
Next, qualify only its affected recovery path and complete
pinned downstream read/edit/publication/save/resume/replacement. No production
cutover is authorized. Routine receipts remain private.

## Execution order

1. Profile the unchanged paths and add targeted fault/performance instrumentation.
   Separate observed counts from hypotheses about latency; do not assume abstraction
   overhead is the cause or that extra I/O is inherently required for safety.
2. Implement the smallest coherent optimizations in the shared layers. Screen
   alternatives locally, including save granularity, batching, verification reuse
   and durable import progress; run affected checks after each change.
3. Freeze one candidate for the hosted matrix. Preserve failed attempts and clean
   owned resources. Repeat only affected failed checks or justified comparisons.
4. Integrate the winning reliable candidate in staging and publish measured results.
   Do not promote a faster but less durable path or claim a universal speedup.

The original v1 real-grace gate passed independently; its evidence is in
[implementation.md](../implementation.md). It does not close this performance goal.
