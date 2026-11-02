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

| Gate                      | Work and required evidence                                                                                                                     | Status                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Explain baseline          | Separate capture/compression, range transport, verification, publication, synchronization and removal costs; record request counts and overlap | Host phases, storage/provider counts and differing controller compositions measured.                                |
| Incremental granularity   | Evaluate smaller independent frames and packing; preserve old archives and bounded reconstruction                                              | 1 MiB members and verified packs qualified; legacy 4 MiB reads preserved; adaptive gzip candidate.                  |
| Save pipeline             | Carry bounded batching/concurrency and remove redundant round trips without weakening publication proof or uncertain-outcome handling          | Bounded pipeline and idle fix measured; latest embedded save 4.052 s vs3.007 s reference; parity open.              |
| Cold import               | Evaluate larger/batched or streamed transfers with durable progress, bounded memory and exact idempotent replay after interruption             | Negotiated durable 4 MiB chunks; old256/512 KiB receipts and replay pass; hosted large restore open.                |
| Fault qualification       | Corruption, short transfer, lost ACK, restart, cancellation, stale generations, old-format restore and GC/publication races on local/S3 paths  | 221 TypeScript/105 Python tests and live R2 recovery pass; new hosted replacement open.                             |
| Matched hosted comparison | Freeze candidate; ten trials per arm across replicated hosts with identical resources/image/workload and independent filesystem checks         | Six separate five-per-arm screens, one pretrial failure preserved; all owned hosts retired; final replication open. |
| Large restore/replacement | Compare a larger generic fixture, real source-deleted replacement and interrupted-transfer recovery                                            | Pending.                                                                                                            |
| Downstream adoption       | Pinned artifact, scoped staging save/resume/replacement, preserved existing checkpoints, owned cleanup and exact-SHA CI                        | Artifact20 pinned; client unit/workerd checks pass; new staging workflow and replacement pending.                   |

## Current local screen

For a deterministic 16 MiB binary with a 4 KiB same-length edit, 256 KiB,
1 MiB and 4 MiB frames uploaded 0.258, 1.045 and 4.192 MB respectively, with
64, 16 and 4 objects. The candidate selects 1 MiB for hosted evaluation. This
geometry screen does not establish end-to-end speed. Packing and larger import
chunks are implemented; final hosted trials must measure their combined cost.
Local and live R2 checkpoint recovery pass all eleven runner checks, including
acknowledgement loss, reopen, retained reconstruction and scoped cleanup. Their
synthetic-clock collection checks do not replace the protected real-grace test.

The [hosted screens](../benchmarks.md#follow-on-checkpoint-optimization-screens)
remain below target. The latest embedded native-store composition measured
4.052 s save versus 3.007 s reference, and 7.198 s whole cycle versus 4.820 s.
All completed oracles pass; the uncertain earlier setup remains preserved, and
all sixteen test and diagnostic hosts are retired. Different controller compositions are reported
separately. None closes the replicated comparison gate.

Adaptive standard-gzip sampling now selects stored members for incompressible
frames and level-one compression for compressible members. In the local screen,
16 MiB binary encoding fell from307 to24 ms, while a mixed source-like fixture
fell from180 to164 ms with0.36% more encoded bytes. These are capture-only local
measurements, not hosted speed evidence. Every full member retains CRC and both
compressed/expanded SHA-256 verification. Source-deleted filesystem tests pass;
existing gzip checkpoints remain readable.

The latest diagnostic separates host and storage timings: metadata transactions
accounted for about1 ms per save, while repeated control requests, archive work
and cleanup remain material. A new candidate uses atomic local-cache publication
with cross-filesystem copy fallback, negotiated bounded1280 KiB source reads and
one replay-safe finalization request. Every underlying cleanup receipt, publication
check and fence remains required. Lost metadata/cleanup acknowledgements, corrupt
cache bytes, stale leases and drained range failures pass locally. Hosted speed
and replacement qualification for these changes remain open.

The first diagnostic on this candidate stopped during priming: its larger source
range reached the controller intact, but the shared decoder still enforced the
ordinary output bound. Checkpoint decoding now uses the exact negotiated request
bound; ordinary output remains unchanged. A full-size lifecycle regression passes.
The original save journal subsequently recovered on its retained host after a
controller update. Three exact cycles passed; the source host and controller were
retired. The failed attempt remains recorded separately from timed comparisons.

The pipeline candidate overlaps filesystem capture with output retention
only after quiescence and stream/input settlement. Both branches drain before a
failure escapes; neither checkpoint publication nor source release can precede
successful output retention. Interruption tests hold each branch independently,
reopen controller state and verify exact outputs and one archive publication.

The next candidate starts capture only once an output upload can overlap it,
persists terminal command outcomes and offers a bounded short-command start wait
(default250 ms, operator range0–1000 ms; terminals remain immediate). Uncertain
starts retain their original identities and never relaunch on reconnect. Local
restart, cancellation and drained-failure checks pass; hosted parity remains open.

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
