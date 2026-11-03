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

| Gate                      | Work and required evidence                                                                                                                     | Status                                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explain baseline          | Separate capture/compression, range transport, verification, publication, synchronization and removal costs; record request counts and overlap | Host phases, storage/provider counts and differing controller compositions measured.                                                                                                                        |
| Incremental granularity   | Evaluate smaller independent frames and packing; preserve old archives and bounded reconstruction                                              | 256 KiB capture members and 8 MiB packs selected; legacy 4 MiB reads and adaptive gzip qualified.                                                                                                           |
| Save pipeline             | Bounded batching/concurrency and fewer control round trips without weaker publication or uncertain-outcome handling                            | Verified warm medians on qualification33; qualification34 missing-only bootstrap meets the observed cold pair target.                                                                                       |
| Cold import               | Evaluate larger/batched or streamed transfers with durable progress, bounded memory and exact idempotent replay after interruption             | Optional16 MiB raw import qualified locally and on fresh hosts; exact source-deleted recovery, progress and cleanup pass.                                                                                   |
| Fault qualification       | Corruption, partial transfer, lost ACK/restart, cancellation, stale generations, old-format restore and GC/publication races                   | 265 TypeScript/14 changed host-control tests and all seven current CI jobs pass; valid prior archive/storage fault evidence reused.                                                                         |
| Matched hosted comparison | Ten trials per arm across replicated equal-resource/image/workload hosts with independent filesystem checks                                    | Verified on qualification33: all20 exact; pooled save/readiness/cycle medians improve, both pair save/cycle medians win, second-pair readiness nearly tied.                                                 |
| Large restore/replacement | Larger generic fixture, source-deleted replacement and interrupted-transfer recovery                                                           | Qualification34 restores436 MB exactly, retains output and repeated saves, and meets observed cold target36.774 versus51.309 s in one pair.                                                                 |
| Downstream adoption       | Pinned artifact, scoped staging save/resume/replacement, preserved checkpoints, owned cleanup and exact-SHA CI                                 | Closed on qualification34: pinned client, exact warm/local-cache and source-deleted replacement, retained session/output, repeated saves, cleanup and exact-SHA CI. Earlier unchanged business flow reused. |

## Qualified result

Qualification34 (`c6864d4`) is published and pinned by the staging client
`f641ebe0`. All182 artifact files match both consumers. Runtime build/types/lint,
265 TypeScript tests and all seven [artifact CI jobs](https://github.com/firtoz/jetski/actions/runs/41550708737)
pass. Existing14 affected host-control checks and unchanged archive/storage fault,
cancellation, old-format, GC-race and live R2 contract evidence are reused.

The implementation retains256 KiB independently compressed capture members in
8 MiB immutable packs, bounded rolling uploads and native storage write/range
proofs. Negotiated16 MiB raw import parts retain durable progress and bounded
reconstruction. A capability-negotiated combined cached resume retains the ordinary
claim/full import verification/create checks under a core reader lease; unsupported
hosts and cache misses use ordinary import. Missing-only Boat package installation
checks the existing compiler without asking to upgrade installed prerequisites.
Archive compatibility, hashes, publication, synchronization and fencing are unchanged.

The frozen warm comparison completed ten trials per arm on two fresh equal-resource
host pairs. All20 independent filesystem checks match; all four hosts/controllers
are absent. Candidate/reference median save is2.4985/4.9225 s, readiness1.1035/2.0175 s
and complete cycle4.933/8.0335 s; sample p95 cycle6.119/10.271 s. Both pair save/cycle
medians improve, while second-pair readiness is nearly tied at1.054/1.042 s. Every
candidate row uses the combined cached path. Provider requests10.5/16 and upload
0.263/1.042 MB improve, while storage requests31/18 remain higher. The warm matrix
uses runtime `62eab00`; exact artifact comparison proves those files unchanged in34.

One changed cold pair restores436,207,724 logical bytes after source deletion with
exact whole-filesystem bytes/modes/links, retained output and repeated saves.
Candidate/reference readiness36.774/51.309 s meets the observed target. Prerequisite
preparation takes8.787 s, installer/image preparation11.226 s, binary writes10.090 s,
final import0.858 s and create0.261 s. This is one pair, not a population-median
claim. The prior188.574/47.045 s result is preserved; its bootstrap lacked the phase
breakdown needed to attribute the entire difference to the package fix. Controller
placement, tails, failures and other measured limits remain in [benchmarks](../benchmarks.md).

Final staging qualification uses the pinned artifact through the real client.
A retained prior checkpoint resumes, saves durably and reuses its verified165,862,269-byte
local archive on the same host. After another durable save and positive source-VM
absence, a different physical host restores from retained remote storage. Both warm
and replacement independent digests match158 entries and322,845,310 logical bytes,
including persistent session files. Original acknowledged command output remains
identical. The final repeated save retains the original archive SHA-256. Earlier
unchanged read/edit/publication/session workflow evidence is reused without another
workload job. Exact-SHA client CI, including staging deployment, passes.

Both final staging hosts have positive absence receipts, inventory shows zero active
hosts, and all89 accounted performance hosts are retired. Temporary controllers and
proxies are removed. Acknowledged checkpoints remain retained; historical uncertain
outcomes stay uncertain. The approved aggregate cap and separate recovery funds,
fixtures, clocks, roots and generations are preserved. No snapshots, top-ups,
operator-runtime changes, production cutover or npm publication were introduced.
Private receipts preserve complete inputs, failures, operations and cleanup.

## Publication closure

Implementation, the finite matched comparison and final staging qualification are
complete. The remaining publication condition is a green exact-SHA main workflow
for this final documentation update; its attached GitHub checks are authoritative.
Do not repeat the closed workload matrix. Record that workflow and the final audit
in the private evidence before closing the goal.

The original v1 real-grace gate passed independently; its evidence is in
[implementation.md](../implementation.md). The separate protected fixture is unchanged.
