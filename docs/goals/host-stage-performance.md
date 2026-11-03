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
Existing session authorization to push main applies to coherent implementation
milestones; monitor exact-SHA CI. No client or default-backend switch is implied.

## Completed finite gates

| Gate               | Evidence                                                                                                                | Status                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Instrumentation    | Optional monotonic core/storage/host spans, bounded allowlisted stderr, privacy/failure containment                     | Complete                           |
| Buffering          | Bounded 1 MiB native extraction buffer; partial/truncated reads and exact interoperability checks                       | Complete                           |
| Round trips        | Opt-in combined quiesce/capture; old-host fallback, lost-ACK reconciliation and publication ordering                    | Complete                           |
| Local checks       | 288 TS, 142 Python, 60 Rust tests; build/typecheck/lint/clippy; runtime candidate all eight CI jobs pass                | Complete                           |
| Matched comparison | Forty valid cycles, two reversed four-arm groups; one preserved R2-failed attempt replaced only after exact recovery    | Complete                           |
| Recovery/cleanup   | Both candidate source-deleted recoveries/original output exact; R2 failure guard exact; all ten owned hosts provider404 | Complete                           |
| Report/publication | [Consolidated results](../host-stage-benchmarks.md); final documentation SHA/CI recorded privately                      | Publication receipt kept privately |

## Result and constraints retained

Instrumentation-only baseline `7fcba34`, candidate `ee37956`. Both native artifacts
and source packs are frozen. Experimental changes did not demonstrate a repeatable
end-to-end win: retain Python default and disabled combined capture. Healthy-host
restore was dominated by sync/publication rather than extraction; slow candidates
also had probe/runtime delays. Fresh-host variation and changed ordering were not
independently isolated; do not attribute every slowdown to one cause.

The user approved a separate $3, existing wallet only, twelve small one-hour hosts
maximum (ten planned plus two failure reserves). Ten starts were used; reserves
unused. Provider compute-value bounds are $0.04326–$0.04346; observed wallet debit
$0 with included starts/credits. Prior experiment and GC funds/fixtures untouched.
All ten owned hosts are absent, active inventory empty, controller exited, durable
history retained. No new host or unchanged verification matrix is authorized here.

Private recovery context: `/home/frtn/.local/state/jetski-qa/host-stages-20261103/`.
`current.json`, `budget.json`, `benchmark/plan.json`, `completed.json`, `report.json`,
`cost-report.json` and `final-audit.json` contain evidence. The original driver,
failed trial and R2 HTTP502 boundary are retained. Do not restart controllers or
replay acknowledged commands. Candidate CI is green; baseline's unchanged Chrome
startup fixture timed out twice and is explicitly reported, not repeatedly retried.
The final documentation commit and its GitHub checks are the publication receipt;
the existing goal closes when those checks pass. No default/client cutover or
additional experiments are included.
