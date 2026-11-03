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

| Gate                      | Work and required evidence                                                                                                                     | Status                                                                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explain baseline          | Separate capture/compression, range transport, verification, publication, synchronization and removal costs; record request counts and overlap | Host phases, storage/provider counts and differing controller compositions measured.                                                                                                         |
| Incremental granularity   | Evaluate smaller independent frames and packing; preserve old archives and bounded reconstruction                                              | 256 KiB capture members and 8 MiB packs selected; legacy 4 MiB reads and adaptive gzip qualified.                                                                                            |
| Save pipeline             | Bounded batching/concurrency and fewer control round trips without weaker publication or uncertain-outcome handling                            | Verified warm medians on qualification33; cold bootstrap remains the next implementation target.                                                                                             |
| Cold import               | Evaluate larger/batched or streamed transfers with durable progress, bounded memory and exact idempotent replay after interruption             | Optional16 MiB raw import qualified locally and on fresh hosts; exact source-deleted recovery, progress and cleanup pass.                                                                    |
| Fault qualification       | Corruption, partial transfer, lost ACK/restart, cancellation, stale generations, old-format restore and GC/publication races                   | 265 TypeScript/14 changed host-control tests and all seven current CI jobs pass; valid prior archive/storage fault evidence reused.                                                          |
| Matched hosted comparison | Ten trials per arm across replicated equal-resource/image/workload hosts with independent filesystem checks                                    | Verified on qualification33: all20 exact; pooled save/readiness/cycle medians improve, both pair save/cycle medians win, second-pair readiness nearly tied.                                  |
| Large restore/replacement | Larger generic fixture, source-deleted replacement and interrupted-transfer recovery                                                           | Qualification34 restores436 MB exactly, retains output and repeated saves, and meets observed cold target36.774 versus51.309 s in one pair.                                                  |
| Downstream adoption       | Pinned artifact, scoped staging save/resume/replacement, preserved checkpoints, owned cleanup and exact-SHA CI                                 | Qualification32 real read/edit/PR and warm/replacement/session gates closed. Qualification34 final changed-cache/bootstrap adoption remains pending; reuse unchanged business-flow evidence. |

## Current candidate and evidence

Runtime `62eab00`, qualification33, adds a capability-negotiated combined cached
resume. Claim, full cached import verification and create share one control call;
the core holds a reader lease and validates checkpoint, assignment, image and
resource identities. Misses never create a runtime and use ordinary import. Hosts
without the advertised capability retain their existing path. Published archive
formats, old4 MiB reads, fencing, synchronization and publication proof are unchanged.

Build, types,265 TypeScript tests (including missing-only prerequisites),14 affected host-control checks and all seven
exact-SHA CI jobs pass. The artifact has180 files and both downstream consumers
match it exactly. Previous archive/storage fault, cancellation, old-format, GC-race
and live R2 consistency evidence is reused where those paths are unchanged.

The frozen warm comparison completed ten trials per arm on two fresh host pairs.
All20 filesystem checks match and all four hosts/controllers have positive absence
receipts. Candidate/reference median save is2.4985/4.9225 s, readiness1.1035/2.0175 s
and complete cycle4.933/8.0335 s. Sample p95 cycle is6.119/10.271 s. Both pair save/
cycle medians improve; second-pair readiness is nearly tied at1.054/1.042 s. Every
candidate row uses the combined cache path. Provider calls are10.5 versus16,
storage calls31 versus18 and changed upload0.263 versus1.042 MB. This closes the
measured warm gate, with host variance and differing controller placement disclosed
in [benchmarks](../benchmarks.md). Do not attribute all latency differences to the
new call composition or repeat this unchanged matrix.

Qualification34 (`c6864d4`) is published with all seven exact-SHA CI jobs passing.
Its missing-only Boat prerequisite fix passes265 TypeScript checks. Exact artifact
diff from qualification33 changes only embedded bootstrap and adds its prerequisite
helper; host assets, checkpoint formats, core, transport and warm code are identical.
Reuse the completed warm matrix instead of retesting unchanged paths.

One changed cold pair restores the original436,207,724 logical-byte fixture after
source deletion with exact whole-filesystem bytes/modes/links, saved-output
continuity, repeated durable saves and owned cleanup. Latest metadata preserves
all acknowledged roots; the historical root is selected without rewinding state.
Candidate/reference readiness36.774/51.309 s meets the observed target. Package
preparation is8.787 s, installer/image preparation11.226 s, binary writes10.090 s,
final import0.858 s and create0.261 s. This is one pair with host/network variance,
not a population-median guarantee. The prior188.574/47.045 s result and its150.893 s
before status are preserved; without prior phase breakdown, do not attribute the
entire difference to the package fix. Prior interruption/fault proofs remain valid.

The qualification32 downstream read/edit/PR, warm/source-deleted full filesystem,
saved output, three-turn session and fresh-task gates passed. Reuse that unchanged
business-flow evidence. Qualification34 is being pinned in both downstream consumers. The qualification33 first deployment was rejected by the platform's startup CPU limit;
a lazy bootstrap-assets import is now on main. The subsequent CI probe omitted
its additional bundle chunks, so deployment was skipped. The probe now supplies
all emitted modules and passes local workerd startup; actual platform acceptance
and final qualification34 staging remain pending. Local profiling alone does not qualify deployment.
Current changed-cache staging save/warm/physical recovery remains open.

All87 accounted performance hosts are retired, with temporary controllers removed.
Completed earlier qualification reservations were reconciled against their verified
one-hour owned allocations, preserving full maximum start/hour funding within the
unchanged approved aggregate cap. Keep other recovery funds, clocks, roots and
generations untouched. No production cutover or active immutable-bundle upgrade.
Private receipts retain failures, frozen inputs, operation identities and cleanup.

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
