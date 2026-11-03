# Rust host backend and matched Python comparison

## Objective and constraints

Implement an opt-in native Rust host backend and compare it with the frozen Python
reference. Read and maintain `/home/frtn/work/2026/jetski/docs/goals/rust-host.md`
at each continuation and after compaction; pursue this complete finite scope.
Keep provider, storage, control-plane and runtime boundaries replaceable. Python
remains the default and reference; no implicit changes to installed immutable
bundles, live assignments, retained archives or clients.

Rust must implement the host control/data path rather than invoke Python for the
measured operations. Existing bootstrap and the small native helpers may remain
where documented. Preserve the versioned wire protocol, execution identities,
command/output/cancel and interactive behavior, exact filesystem bytes/modes/links,
checkpoint format readability, cache validation and durable generation fencing.
Remote publication verification, reader/writer coordination, pins and fail-closed
GC remain authoritative in the portable core. Unknown saves retain/quarantine the
source; unknown commands are observed rather than blindly replayed. There is no
absolute zero-loss guarantee: preserve acknowledged data under the stated durable
boundary and expose unavailable unpublished changes explicitly.

No default switch, client staging/production cutover, npm publication, snapshots,
cross-owner reuse, desktop runtime installation/reconfiguration or subagents.
Public source/docs/commits stay generic. Existing experiments, protected fixtures,
client dirty files and their funds remain untouched. Do not rewrite the controller
or introduce a mandatory daemon merely to manufacture a language speed comparison.

## Completed finite acceptance matrix

| Gate                  | Evidence                                                                                                    | Status                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Contract audit        | [Action and boundary map](../../host-rust/contract.md), scoped limits retained                              | Complete                                 |
| Native implementation | Native control/files/archive/cache/exec/terminal/TCP; no measured Python fallback                           | Complete                                 |
| Modular selection     | Immutable hash/intent, Boat and adopted-SSH transport integration, optional binary artifact                 | Complete                                 |
| Targeted conformance  | 59 Rust, 282 TypeScript and three installer tests; cross-language and failure checks                        | Complete                                 |
| Matched benchmark     | Two reversed host pairs, ten cycles per backend, one exact source-deleted replacement each                  | Complete                                 |
| Native live paths     | Binary file transfer, PTY input/resize/signals, cancellation, SSH HTTP/binary TCP; final exact save         | Complete                                 |
| Report and cleanup    | [Consolidated measurements](../rust-host-benchmarks.md); all eight owned hosts provider404, no active hosts | Complete                                 |
| Publication           | Runtime `6d6b688` all eight CI jobs green; final documentation SHA tracked in private handoff               | Final publication receipt kept privately |

Python remains the default. Median whole cycles were 13.45 s Python and 13.62 s
Rust; opposite pair results do not show a consistent speed win. Exact fixture
comparisons and retained publication passed, without an absolute zero-loss claim.
Two native pre-admission setup bugs were fixed before successful samples; failures
and harness repairs remain recorded in the report and private receipts.

## Budget and recovery context

On November 3 the user approved **a separate additional $3**, existing Boat wallet
only, no top-up: at most eight small one-hour hosts (four matched hosts, two source-
deleted replacements, two failure reserves). No minimum warm fleet or snapshot.
Conservative reservation at $0.07/start plus $0.036/hour is $0.848 for all eight;
account for actual size-weighted usage, included credits, wallet debits and start
fees separately. Request further authorization before exceeding either cap.

Repository `/home/frtn/work/2026/jetski`, branch main. Frozen initial Python
reference `8bb303f46c78c41d9a68f814953a96fa12467adc`; previous full CI passed seven
jobs. Host Python/native assets unchanged since the qualified baseline. Existing
Rust 1.97.1/Cargo 1.97.1 are available; no toolchain installation is needed.
Private plans, budget, IDs, receipts and failures live under the operator QA state
`rust-host-20261103`; the separate hosted comparison is now running.
Its private budget journal is authoritative for admitted/observed/retired hosts.

## Final state and recovery context

Implementation and the finite hosted matrix are complete. Runtime `6d6b688` has
all eight CI jobs green. The separate musl executable is 1,676,000 bytes, SHA-256
`5ba5edd2f469eecdda3388908a73a61c31bed1e4c3d24d9b722fdde7b39a540c`.
Core and default Python host behavior remain at the frozen reference boundary.

All eight starts were used, including both failure reserves; no further allocation
is allowed under this plan. All eight hosts have positive provider404 confirmation;
final active inventory is empty and both controller/observer exited. Durable
checkpoint history remains retained. Observed wallet debit was $0; conservative
compute value is at most $0.0319. Per-host provider usage was unavailable because
the observer used a locally rejected route; this limitation is explicit in the report.

Private evidence: `/home/frtn/.local/state/jetski-qa/rust-host-20261103/benchmark/`:
`completed.json`, `report.json`, `final-audit.json`, four arm receipts and failed
attempts. The private `current.json` tracks final publication/CI. Do not restart
controllers, allocate another host or rerun unchanged matrices for documentation.

## Closure

Implementation, hosted measurements and owned cleanup are complete. Final
documentation publication and exact-SHA CI are recorded in the private handoff
and GitHub checks for this document’s commit. Goal completion requires those
checks to pass; no new hosted matrix is needed. No client/default switch accompanies it.
