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

| Gate                      | Work and required evidence                                                                                                                     | Status                                                                                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explain baseline          | Separate capture/compression, range transport, verification, publication, synchronization and removal costs; record request counts and overlap | Store and provider counts measured; packed screen isolates two 10.35 s quiesce intervals and output-retention overhead                                                                                                                        |
| Incremental granularity   | Evaluate smaller independent frames and packing; preserve old archives and bounded reconstruction                                              | Local geometry screen selects 1 MiB capture; old 4 MiB source-deleted filesystem restore passes; Opt-in physical packs with verified logical slices implemented; old/new source-deleted local and R2 restore pass                             |
| Save pipeline             | Carry bounded batching/concurrency and remove redundant round trips without weakening publication proof or uncertain-outcome handling          | Opt-in bounded upload, reuse/publication/release/recovery verification implemented; physical packing reduced hosted storage requests to40 but missed target; signal-aware idle and bounded output retention implemented, hosted check pending |
| Cold import               | Evaluate larger/batched or streamed transfers with durable progress, bounded memory and exact idempotent replay after interruption             | Negotiated 4 MiB durable chunks through existing adapters; legacy 256/512 KiB receipts and cross-frame lost-ACK/journal replay pass; hosted large restore pending                                                                             |
| Fault qualification       | Corruption, short transfer, lost ACK, restart, cancellation, stale generations, old-format restore and GC/publication races on local/S3 paths  | 216 TypeScript and 97 Python tests pass; packed journal restart, lost ACK, writer revocation, retained slice GC and live R2 exact recovery pass; hosted paths pending                                                                         |
| Matched hosted comparison | Freeze candidate; ten trials per arm across replicated hosts with identical resources/image/workload and independent filesystem checks         | Five/arm completed; second pair failed before trials; all four hosts retired. Final replicated comparison pending                                                                                                                             |
| Large restore/replacement | Compare a larger generic fixture, real source-deleted replacement and interrupted-transfer recovery                                            | Pending                                                                                                                                                                                                                                       |
| Downstream adoption       | Pinned artifact, scoped staging save/resume/replacement, preserved existing checkpoints, owned cleanup and exact-SHA CI                        | Pending                                                                                                                                                                                                                                       |

## Current local screen

For a deterministic 16 MiB binary with a 4 KiB same-length edit, 256 KiB,
1 MiB and 4 MiB frames uploaded 0.258, 1.045 and 4.192 MB respectively, with
64, 16 and 4 objects. The candidate selects 1 MiB for hosted evaluation. This
geometry screen does not establish end-to-end speed; packing and bulk transport
remain alternatives if the measured request/restore costs still miss the target.
Local and live R2 checkpoint recovery pass all eleven runner checks, including
acknowledgement loss, reopen, retained reconstruction and scoped cleanup. Their
synthetic-clock collection checks do not replace the protected real-grace test.

The [first hosted screen](../benchmarks.md#follow-on-checkpoint-pipeline-screen)
missed the speed target despite reducing upload volume. Its second host pair
failed before timed trials; all four hosts are retired and evidence is preserved.
It does not close the replicated comparison gate or justify downstream adoption.
The subsequent packed screen also missed parity (17.517 s save versus 4.389 s).
Persisted phase observations isolated a ten-second idle-process stop timeout;
a signal-handling idle process and bounded, fully drained output retention now
address that concrete delay. Their fresh hosted comparison remains pending.

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

The original v1 release's remaining real-grace gate is tracked separately in
[implementation.md](../implementation.md). This follow-on goal does not close it.
