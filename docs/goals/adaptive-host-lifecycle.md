# Longer leases and adaptive idle retention

## Objective and scope

Implement portable configurable host lifetimes and bounded adaptive idle retention,
measure actual resource/cost savings against one-hour/ten-minute retention, and
qualify a pinned release in the existing staging client. Read and maintain this
file at each continuation and after compaction; pursue all gates without repeating
unchanged verification matrices. Detailed results belong in the
[consolidated report](../host-lifecycle-benchmarks.md), not a run diary.

Keep policy/provider/state/scheduling replaceable. Core policy has no filesystem,
network client or credential dependency. The opt-in profile uses eight-hour leases,
five-minute drain, two-to-sixty-minute idle bounds, ten-minute stale-price fallback
and a bounded per-idle-decision spending cap. Fixed policy and operator overrides
remain supported; defaults stay one hour and ten minutes.

Preserve original allocation identities/deadlines and per-slot policy snapshots;
never silently extend a host or upgrade its live immutable bundle. Persist bounded
owner return history, price snapshots and retirement decisions. Admission, drain,
maintenance wakeups and retirement use consistent deadlines. Restart, stale input,
competing writers and uncertain effects cannot extend spending or erase work.
Provider prices refresh outside transactions through a bounded injectable source.

Preserve exact bytes, modes, symlinks/hardlinks, session/output, one assignment per
host, owner isolation, command timeouts, generation fences, verified publication
and local cache, reader/writer coordination, pins and fail-closed GC. Save durably
before release; failed or uncertain saves retain/quarantine their sources. Existing
archives and the separate real-grace experiment, active references and funds remain
untouched. Do not edit/stage/restore the client's unrelated dirty GC goal file.

Public source/docs/examples/commits remain generic; all client-specific wiring and
private receipts stay outside this repository. No cross-owner reuse, snapshots,
top-ups, purchases, production cutover, npm publication, desktop runtime changes,
subagents or new model/broker/PR qualification runs. Reuse unchanged evidence and
fix concrete failures without expanding the acceptance matrix.

## Finite acceptance matrix

| Gate                    | Evidence and status                                                                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portable implementation | Qualification 35: validated policy, bounded history/quotes, shared deadlines, Boat/adopted-host capabilities, CLI and embedded configuration; complete                                                           |
| Lifecycle reliability   | 278 runtime tests, controller/config checks, root builds/types/lint, replay/stale-input/budget/queue-versus-retirement bounds; real clock and exact cold recovery passed                                         |
| Matched comparison      | Two replicas, 51 busy cycles per arm plus actual 25-minute idle and cold return: all 208 cycles exact; six starts before/four after                                                                              |
| Honest accounting       | Provider normalized-second/value readings with absence-tail bounds, observed host/idle time, latency, bytes/requests and constant-fee sensitivity; complete, mixed speed result retained                         |
| Scoped staging          | Pinned artifact/adopted policy, same host beyond 61 minutes, durable save, source provider404/different-host recovery, exact filesystem/session/original output, final retained checkpoint and cleanup; complete |
| Publication and cleanup | All twelve owned hosts positively retired, zero active provider inventory and temporary workers removed; final consolidated publication is subject to exact-SHA CI closure gate                                  |

## Current evidence and limits

Runtime `cb20593813db9fc9dad0a645e57742302b37ee7e`, qualification 35; both installed
client consumers match all 186 artifact files. Runtime source/main CI and client
implementation/config-deploy CI passed. Host Python assets and checkpoint formats
are unchanged. Boat and adopted-host adapters support a bounded 24-hour maximum;
uncertain Boat allocation retry ends within 23 hours independently of physical TTL.
Existing slots retain their original fixed policy until explicitly idle-adopted.

The measured trace reduced starts 6→4, observed host time 7.7%, last-gap idle
retention about 80% and remote downloads 50%. Warm resume/save medians regressed;
ordinary warm latency is not advertised as improved. Setup/driver corrections,
provider sample tails, host variation and unchanged-checkpoint scope are disclosed
in the report. No absolute zero-loss or universal speedup claim is made.

The user approved a separate additional $10 on November 3 from the existing wallet,
no top-up: at most 24 starts/eight-hour leases, split 20 comparison and four staging.
Actual qualification used ten comparison plus two staging hosts, all retired,
$0.13511 of included compute credits and $0 wallet debit. The prior experiment cap
and separate recovery reservation were not reused.

Private recovery context lives in the operator's local QA state under
`lifecycle-20261103/current.json`, with frozen plans, IDs, failed setup receipts,
verified controller idle-boundary correction, raw timing/usage and cleanup proofs.
The temporary follow-up continues only remaining publication work. Do not rerun
completed benchmarks or staging, recreate plans, or allocate more hosts.

## Publication closure

This milestone publishes the consolidated report and client rollout documentation
on main. Successful exact-SHA CI in both repositories is the final closure gate;
[source checks](https://github.com/firtoz/jetski/actions) and the private closure
receipt retain the final outcomes. All implementation, comparison, scoped staging
and owned cleanup work is complete. Close the existing goal and delete its
follow-up only after those checks pass; do not rerun completed qualification.
