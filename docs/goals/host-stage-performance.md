# Host stage instrumentation and targeted performance

## Full objective and constraints

Instrument Python and Rust resume/save stages, implement bounded buffering and safe
round-trip optimizations, then compare both backends with their frozen baselines.
Read and maintain `/home/frtn/work/2026/jetski/docs/goals/host-stage-performance.md`
at the start of every continuation and after compaction; pursue the complete finite
scope. Keep provider/runtime/storage boundaries modular and Python the default.
Preserve acknowledged bytes, modes, symlinks/hardlinks, command identities and
uncertain outcomes, immutable backend selection, generation fencing, verified
publication/cache reuse, reader/writer coordination, pins and fail-closed GC.
Do not promise absolute zero loss or trade verification guarantees for speed.

No subagents, snapshots, desktop runtime installation/reconfiguration, client
cutover, npm publication, cross-owner reuse, top-ups or prior budget/fixture use.
Paid hosts need a separate approved allowance. Keep public material generic and
receipts/credentials private. Inspect current processes/inventory before allocating.
No publication beyond existing user authorization; retain coherent local changes
if publication is not authorized for this goal.

## Finite gates

| Gate                  | Required evidence                                                                                                                                                                            | State       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Stage instrumentation | Optional bounded, privacy-safe timing sink; host extraction/runtime/capture/finalize and core storage/publication timings; wall vs CPU and nested spans explicit                             | In progress |
| Buffering             | Bounded Rust extraction buffers, exact oracle/corruption/partial-stream checks; same fsync/publication boundary                                                                              | Open        |
| Round trips           | Remove only demonstrated redundant requests or safely overlap independent reads; preserve replay/uncertainty/durable ordering                                                                | Open        |
| Local qualification   | Targeted changed-path tests; build/typecheck/lint/native checks once per coherent candidate                                                                                                  | Open        |
| Matched comparison    | Instrumentation-only baseline vs optimized candidate for Python/Rust; two reversed pairs, five cycles per variant per pair (40 total); same workload/image/resources/R2 and durable boundary | Open        |
| Recovery and cleanup  | One source-deleted replacement per optimized backend; exact bytes/modes/links; positive owned absence; reuse unchanged interactive qualification                                             | Open        |
| Report                | Stage distributions/overhead/CPU scope/bytes/requests/costs/failures; negative results retained; no speed target or matrix expansion                                                         | Open        |

Implementation first, then freeze instrumented baseline/candidate and run one
hosted matrix. Instrumentation-only baselines make observer overhead comparable;
previous unchanged receipts remain contextual evidence, not newly timed controls.
At most ten planned hosts (eight matrix arms and two candidate replacements), plus
two failure reserves, each small and at most one hour. No new interactive/model/PR
matrix. Preserve failed rows/IDs and rerun only an affected failure after a fix.
If no safe request reduction is found, document that finding rather than weaken
semantics. Do not repeatedly profile/retest unchanged components or chase wins.

## Baseline and recovery context

Workspace `/home/frtn/work/2026/jetski`, main `c44ff7511c12dd8efb0fabdf8b020254d5c9d7ab`,
clean at goal start. Previous native runtime `6d6b688` passed its finite matrix:
mean resume Python4.57s/Rust5.77s, mean save7.56s/7.64s. Slow Rust resume/system CPU
was concentrated on one host; buffering is a hypothesis, not a proven cause.
Independent breakdown: private `rust-host-20261103/benchmark/breakdown.json`.
The old observer's `/usage` route was locally rejected: fix diagnostics before
new measurements; never claim exact provider billing from failed samples.

Private state for this goal: `/home/frtn/.local/state/jetski-qa/host-stages-20261103/`.
No controller or host is allocated for this goal yet. User approved separate allowance on November 3:
up to $3, twelve starts maximum, existing wallet only; worst-case reservation at
$0.07/start and $0.036/hour is $1.272. Prior funds remain untouched.

## Next actions

1. Implement optional monotonic stage timing without changing lifecycle outcomes;
   distinguish nested host stages and storage/request spans from total wall time.
2. Implement bounded extraction buffering and inspect concrete serial requests.
3. Complete affected checks, freeze identical instrumented controls/candidates,
   execute the finite paid matrix only after funding approval, then report/clean.
