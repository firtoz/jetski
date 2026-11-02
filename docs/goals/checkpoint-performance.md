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
| Save pipeline             | Carry bounded batching/concurrency and remove redundant round trips without weakening publication proof or uncertain-outcome handling          | Bounded pipeline implemented; latest warm medians beat reference on both pairs; large save gap and tails remain.                           |
| Cold import               | Evaluate larger/batched or streamed transfers with durable progress, bounded memory and exact idempotent replay after interruption             | Optional16 MiB raw import qualified locally and on fresh hosts; exact source-deleted recovery, progress and cleanup pass.                  |
| Fault qualification       | Corruption, short transfer, lost ACK, restart, cancellation, stale generations, old-format restore and GC/publication races on local/S3 paths  | 236 TypeScript/124 Python tests, all seven host CI jobs and large source-deleted/lost-ACK recovery pass.                                   |
| Matched hosted comparison | Freeze candidate; ten trials per arm across replicated hosts with identical resources/image/workload and independent filesystem checks         | Frozen ten-per-arm comparison completed with all20 exact and lower warm medians on both pairs; tails remain worse.                         |
| Large restore/replacement | Compare a larger generic fixture, real source-deleted replacement and interrupted-transfer recovery                                            | Fresh raw-import recovery and repeated saves pass; whole readiness101.045 vs218.556 s in one pair; larger first-save gap remains.          |
| Downstream adoption       | Pinned artifact, scoped staging save/resume/replacement, preserved existing checkpoints, owned cleanup and exact-SHA CI                        | Pinned deployment and guarded profile adoption pass; real file inspection and single-file edit pass; publication and recovery remain open. |

## Current candidate and evidence

Current main `ae17299` carries ordered binary source streams, bounded rolling
uploads, 256 KiB independent members in 8 MiB packs, verified local-cache reuse,
optional 16 MiB raw import, streaming object/range verification and capture hashing
during writes. The optional native R2 adapter adds provider-validated SHA-256,
fresh version-bound publication observations and a bounded aggregate range-proof
cache. Checkpoint formats and the host bundle remain unchanged by these storage
follow-ons; legacy 4 MiB frames stay readable.

The latest follow-on adds optional `putBuffer`, borrowing a prepared pack only
until the adapter promise settles. Native validated writes advertise four upload
slots, matching the reference; stream inputs retain copy semantics. Local/S3
remain at two and command retention keeps its separate two-command memory bound.
All 36 affected storage/packed/frame/command checks, build, types and lint pass.
All seven exact-SHA runtime CI jobs pass at `ae17299`, released as qualification31.
The larger-source pair measures 13.664 versus 22.579 s, with exact fixtures, zero
verification payload downloads and owned cleanup. The exact-build warm comparison completed on two host pairs with all20
filesystem comparisons matching. Median save is 3.5355 versus4.308 s, but resume
is 1.7625 versus1.168 s and the complete cycle6.7585 versus6.369 s. The warm
cycle/readiness target remains unmet; do not replace these results with older
favorable timings. Valid earlier corruption,
lost-ACK, restart, cancellation, stale-generation, old-format and GC-race evidence
is reused. Every started sibling must drain before cleanup or publication;
verification, immutable identities, fences, reader/writer coordination and pins
remain mandatory.

The frozen warm comparison at `f02cc84854d0a3cbb4c5a39be967d6b21fd18cca` has ten
trials per arm on two host pairs. All20 filesystem oracles match. Candidate median
save, resume and complete-cycle times beat reference on both pairs; resume/cycle
tails are worse. Later large-transfer changes do not justify rerunning unaffected
warm trials. Controller placement and transport differences are disclosed in the
[consolidated report](../benchmarks.md); do not claim universal speedups.

The larger fixture has18 normalized entries,436,207,724 logical bytes and two
hardlink groups. Source-deleted replacement matches the complete candidate
filesystem, modes, links and saved command output; repeated saves pass. Raw-import
whole readiness is101.045 versus218.556 s in one fresh-host pair. Bootstrap
variation is substantial; candidate import-only timing was not separately measured.
Both machines and temporary controllers are retired. Earlier failed attempts,
independent oracles and retained archives remain available in private evidence.

**Final performance acceptance remains open.** Native verified-write
pairs at `273bbb8` measure candidate/reference 17.441/128.107 s and
17.608/16.815 s. The reference varies widely; do not pool unlike configurations or
claim parity from its outlier. At `3364293`, the dense-proof cache removes all
verification payload downloads, but save time is 22.398/16.118 s. All these source
fixtures match, and their hosts/controllers are retired. Fewer bytes alone do not
establish latency parity. Earlier comparisons remain in the consolidated report.

Both native [R2 storage policies](../storage-r2.md) pass the live consistency/
recovery contract, checksum rejection and independent byte reads. Its temporary
Worker/prefix are cleaned without an execution host. Missing native capabilities
fall back to complete readback; custom metadata or an S3-shaped API is insufficient.
The latest four-upload larger-source pair beats the unchanged reference, as
reported above. The complete warm matrix above has ten observations per arm; sample p95/max
cycle is8.890 versus7.590 s and readiness3.157 versus1.957 s. All four hosts and
controllers are retired. A local qualification-driver defect also added250 ms
after successful reconciliation. Its immediate-recheck fix passes three local
checks, but the measured matrix is preserved without subtracting estimated delays.
Next, profile and implement warm activation improvements before further paid
qualification; preserve every cache proof, reader lease and activation fence. Provisional transfer may overlap work, but completion and
execution remain behind the verified root. Publication changes metadata rather
than copying payloads.

Downstream artifact pinning and guarded idle-profile adoption are implemented.
Historical uncertain outcomes must remain uncertain; only current fences, settled
lifecycle receipts and fresh provider absence can establish idle migration safety.
Guarded idle-profile adoption and the preceding pinned deployment passed. Real
file inspection found the README without edits, and a single-line edit changed
only that file. Publication timed out before review/push; server-owned cleanup
saved generation4 before host expiry, and provider absence is confirmed.
Never-started lifetime admission now has an explicit durable outcome, and the
client uses stage-sized publication budgets. Qualification29 passed client quality/security CI but its staging deployment
failed Cloudflare's startup CPU check; preserve that failure. Qualification31 is
now pinned on client main, with root build/types/lint, affected checks and actual
binding-state/storage contracts passing. Its entire exact-SHA client CI run passes, and actual staging settings match
qualification31 with the unchanged scope configuration. Publication, warm resume
and physical replacement remain open; finish the warm implementation before
repeating that paid workflow. No production cutover is authorized.
Routine receipts, diagnostics and process handles stay in private QA notes.

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
