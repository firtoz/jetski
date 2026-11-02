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

| Gate                      | Work and required evidence                                                                                                                     | Status                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Explain baseline          | Separate capture/compression, range transport, verification, publication, synchronization and removal costs; record request counts and overlap | Host phases, storage/provider counts and differing controller compositions measured.                                           |
| Incremental granularity   | Evaluate smaller independent frames and packing; preserve old archives and bounded reconstruction                                              | 1 MiB members and verified packs qualified; legacy 4 MiB reads preserved; adaptive gzip candidate.                             |
| Save pipeline             | Carry bounded batching/concurrency and remove redundant round trips without weakening publication proof or uncertain-outcome handling          | Bounded pipeline and idle fix measured; frozen comparison completed; per-host ranking reverses, so reliable parity stays open. |
| Cold import               | Evaluate larger/batched or streamed transfers with durable progress, bounded memory and exact idempotent replay after interruption             | Negotiated durable 4 MiB chunks; old256/512 KiB receipts and replay pass; hosted large restore open.                           |
| Fault qualification       | Corruption, short transfer, lost ACK, restart, cancellation, stale generations, old-format restore and GC/publication races on local/S3 paths  | 232 TypeScript/116 Python tests and live R2 recovery pass; new hosted replacement open.                                        |
| Matched hosted comparison | Freeze candidate; ten trials per arm across replicated hosts with identical resources/image/workload and independent filesystem checks         | Frozen ten-per-arm comparison completed with all20 exact; opposite host rankings leave performance parity open.                |
| Large restore/replacement | Compare a larger generic fixture, real source-deleted replacement and interrupted-transfer recovery                                            | Large source published and deleted; import-envelope limit diagnosed; recovery pending.                                         |
| Downstream adoption       | Pinned artifact, scoped staging save/resume/replacement, preserved existing checkpoints, owned cleanup and exact-SHA CI                        | Artifact20 pinned; client unit/workerd checks pass; new staging workflow and replacement pending.                              |

## Current candidate and evidence

The source now includes bounded verification/transfer concurrency, verified
physical packs, adaptive gzip, atomic local-cache publication, negotiated4 MiB
imports and replay-safe host finalization. It also persists terminal outcomes and
bounded output proofs, overlaps capture with output upload, and coalesces adjacent
source reads. Every original publication, fencing and failed-sibling barrier stays
required. Stable operator choices are documented in [standalone.md](../standalone.md).

The next hosted candidate selects256 KiB capture members,8 MiB packs and the
opt-in8192-byte inline-output threshold. General defaults remain1 MiB members and
inline output disabled. Geometry is persisted per shutdown; large captures grow
toward4 MiB. Old4 MiB archives and output format1 remain readable. Format2 inline
bytes require a supporting reader when rolling back controller binaries.

Local quality passes232 TypeScript and116 Python tests, build, types, lint and
Ruff. Fault checks cover lost acknowledgements, restart/settings changes, missing
sources, exact bytes/modes/links, corrupt proofs blocking publication/read/GC and
drained parallel failures. Mixed inline/object output also recovers exactly with
live R2 and a restarted workerd SQLite fixture using the downstream state adapter.
These checks do not close fresh-host or downstream staging qualification.

The local64 MiB geometry screen reduced changed encoded bytes from1,045,819
with1 MiB members to259,147 with256 KiB members, with nine initial packs in
either case. Local encoding is not hosted performance evidence.

The frozen comparison completed ten trials per arm across two host pairs, with
all20 independent filesystem oracles exact. Pooled save medians were3.638 versus
6.617 s, complete cycles9.218 versus13.047 s, and resume3.964 versus3.839 s.
The per-host ranking reversed sharply between replicas. These pooled numbers do
not establish reliable parity; a same-owner, sequential same-host diagnostic is
planned to distinguish runtime costs from host variability. One failed reference
setup remains recorded separately, with no timed trials; its empty resources were
removed. The detailed benchmark report will retain tails and every failed setup.

Native image setup previously spent substantial I/O remapping image ownership.
Explicit private mappings now preserve observed parent-map boundaries and keep
workload UID/GID1000 separate from engine ownership. Root identity/configuration
receipts are immutable, fsynced and integrity checked; ambiguous maps fail closed.
All seven integration CI jobs and a fresh three-cycle Boat pilot pass. Existing
host assets are never upgraded in place.

The larger fixture has18 entries,436,207,724 logical bytes including hardlinks,
and a201,573,270-byte archive. Its source was durably published and physically
retired. Replacement failed before its first imported chunk: the four-MiB binary
chunk's JSON envelope exceeds Boat's five-MiB direct file-write bound. The retained
archive and independent oracle are protected. Larger control files now use a
short-lived HTTPS upload capability without forwarding API credentials; exact host
length/hash verification still precedes execution. Lost acknowledgements and
invalid, expired or redirected capabilities cannot dispatch an uncertain command.
All232 TypeScript checks, build, types and lint pass locally. Existing-host recovery
and a fresh uninterrupted comparison remain open; no source-loss success is claimed.

The next step is one frozen replicated comparison of the combined candidate,
followed by the large cold/replacement and pinned-client staging gates. Whole
request timings govern performance decisions; phase traces alone are not CPU
accounting. Keep private receipts and recovery handles in the private QA handoff.

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
