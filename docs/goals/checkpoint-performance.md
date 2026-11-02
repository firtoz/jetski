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

| Gate                      | Work and required evidence                                                                                                                     | Status                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Explain baseline          | Separate capture/compression, range transport, verification, publication, synchronization and removal costs; record request counts and overlap | Host phases, storage/provider counts and differing controller compositions measured.                            |
| Incremental granularity   | Evaluate smaller independent frames and packing; preserve old archives and bounded reconstruction                                              | 1 MiB members and verified packs qualified; legacy 4 MiB reads preserved; adaptive gzip candidate.              |
| Save pipeline             | Carry bounded batching/concurrency and remove redundant round trips without weakening publication proof or uncertain-outcome handling          | Bounded pipeline and idle fix measured; latest embedded save 4.052 s vs3.007 s reference; parity open.          |
| Cold import               | Evaluate larger/batched or streamed transfers with durable progress, bounded memory and exact idempotent replay after interruption             | Negotiated durable 4 MiB chunks; old256/512 KiB receipts and replay pass; hosted large restore open.            |
| Fault qualification       | Corruption, short transfer, lost ACK, restart, cancellation, stale generations, old-format restore and GC/publication races on local/S3 paths  | 231 TypeScript/116 Python tests and live R2 recovery pass; new hosted replacement open.                         |
| Matched hosted comparison | Freeze candidate; ten trials per arm across replicated hosts with identical resources/image/workload and independent filesystem checks         | Seven separate five-per-arm screens; setup failures preserved, all owned hosts retired; final replication open. |
| Large restore/replacement | Compare a larger generic fixture, real source-deleted replacement and interrupted-transfer recovery                                            | Pending.                                                                                                        |
| Downstream adoption       | Pinned artifact, scoped staging save/resume/replacement, preserved existing checkpoints, owned cleanup and exact-SHA CI                        | Artifact20 pinned; client unit/workerd checks pass; new staging workflow and replacement pending.               |

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

Local quality passes231 TypeScript and116 Python tests, build, types, lint and
Ruff. Fault checks cover lost acknowledgements, restart/settings changes, missing
sources, exact bytes/modes/links, corrupt proofs blocking publication/read/GC and
drained parallel failures. Mixed inline/object output also recovers exactly with
live R2 and a restarted workerd SQLite fixture using the downstream state adapter.
These checks do not close fresh-host or downstream staging qualification.

In the local64 MiB geometry screen, changed encoded bytes fell from1,045,819
with1 MiB members to259,147 with256 KiB members, using nine initial physical
packs in either case. Capture measured377 versus349 ms; these are local encoding
measurements. The [six hosted screens](../benchmarks.md#follow-on-checkpoint-optimization-screens)
still miss parity: the latest save was4.052 versus3.007 s and complete cycle7.198
versus4.820 s. Completed oracles pass; twenty-six prior comparison/diagnostic hosts are
retired. The FUSE screen completed all ten exact trials, but save and resume
medians were6.815 and7.363 s versus3.670 and1.070 s; parity remains open. Failures remain preserved, including a priming decoder-bound failure
recovered on its original host. Different candidates/controllers are never pooled.

Four later attempts stopped before timed trials. The latest runtime trace showed
Podman waiting for a child to remap ownership across its image layer; that child
wrote1.13 GB and waited for filesystem journal commits before eventually finishing.
The earlier engine-contention hypothesis was incomplete. Shared-engine lifecycle
control passes all seven disposable-host CI jobs, but did not resolve this cost.
The harness selected native overlay, whereas the client explicitly selects FUSE
overlay. The new comparison uses that intended candidate policy and verifies the
live mount program before priming. The reference remains on native overlay; report
this configuration difference and preserve the failed setups separately.

A native image-preparation pilot reached its20-minute observation deadline before
assignment. It is preserved as a failed setup; its unassigned VM and controller
were removed. Moving the same expensive ownership remap earlier was insufficient.
The next candidate instead derives persistent-file ownership from observed
rootless UID/GID maps and uses a private mapping aligned with the image layers.
Workloads remain UID/GID1000 with the same capability, privilege and namespace
controls. Root-owned identity metadata is immutable, fsynced and integrity-checked;
foreign, ambiguous, corrupt or changed mappings fail before admission. Direct
runtime embeddings retain their existing default and can supply an explicit
namespace and filesystem identity. All116 Python and231 TypeScript tests pass,
including lost-ACK metadata publication and distinct engine/storage ownership.
Integration CI caught two startup defects before paid qualification. The engine's
traversal parent is now root-owned and separate from workload-owned contents.
OCI diagnostics then showed that the zero-valued keep-id option produced a
rejected GID map. Explicit identity ranges now preserve the observed parent-map
boundaries in a private namespace, without combining incompatible userns options.
Both maps are validated and included in immutable identity/configuration receipts;
missing, overlapping, gapped or changed ranges fail closed. Local checks pass;
actual host CI and a fresh pilot still gate comparison.

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
