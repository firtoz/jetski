# Longer leases and adaptive idle retention

## Objective

Implement portable configurable host lifetimes and bounded adaptive idle retention,
measure actual resource and cost savings against the current one-hour/ten-minute
policy, and qualify a pinned release through the existing staging client.
Read this file at each continuation and after compaction; maintain its finite
matrix and private recovery pointer instead of appending a run diary.

## Scope and constraints

- Keep provider, core policy, transactional state and scheduling replaceable.
  Core policy cannot import provider credentials, network clients or filesystem APIs.
- Start with an opt-in eight-hour maximum lease and bounded two-to-sixty-minute
  adaptive idle range. Preserve a fixed policy and explicit operator overrides.
  Validate provider capabilities and operator bounds. A longer lease is not a
  promise to keep an idle host running for its entire lifetime.
- Retain immutable allocation identities and original expiration for existing
  hosts. No silent in-place lease extension or live immutable-bundle upgrade.
- Persist bounded owner reuse history, policy identity and retirement decisions.
  Admission, scheduler wakeups, drain and retirement guards must use consistent
  actual deadlines. Restart, stale observations and competing writers cannot
  extend spending or erase an admitted wakeup.
- Keep owner isolation, one active assignment per host, command timeouts,
  generation fencing, verified publication, cache verification, reader/writer
  coordination, pins and safe GC unchanged. Save durably before releasing a
  workload; retain/quarantine uncertain sources. No bytes may be acknowledged
  before the existing publication boundary.
- Use current effective pricing/limits through an injectable bounded snapshot;
  no provider calls inside state transactions. Predictive policy may choose only
  within operator caps. Missing/stale pricing must have a conservative fallback.
- Public source, docs, examples, fixtures and commits stay generic. Keep all
  client-specific wiring and private experiment receipts outside this repository.
- No snapshots, wallet top-ups, production cutover, npm publication, desktop
  runtime changes or subagents. Preserve existing checkpoints and the separate
  recovery/real-grace fixtures and funds. Do not edit or stage the client's
  unrelated dirty GC goal file.
- Paid-host qualification needs a separate allowance for this goal. Previous
  experiment reservations are not new spending authority. Local work proceeds
  while that allowance is pending.

## Finite acceptance matrix

| Gate                          | Required evidence                                                                                                                                                   | Status                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Portable implementation       | Validated lifetime/idle policy, persisted decisions/history, shared deadlines, Boat and adopted-host capability handling, server/embedded configuration             | Core/CLI, bounded provider pricing and pinned client admission/scheduling implemented                  |
| Changed lifecycle reliability | Restart/replay, stale policy/price inputs, bounds/budgets, queued demand versus retirement, lifetime drain, cleanup and source preservation                         | 278 runtime tests and controller/config checks; root builds/types/lint pass; hosted acceptance remains |
| Measured comparison           | Two matched replicas of a frozen trace crossing the one-hour boundary and a longer idle gap; equal images/resources/fixtures                                        | Frozen trace and driver prepared; separate allowance pending                                           |
| Honest cost accounting        | Actual starts, provider VM usage, retained idle time, R2 bytes/requests and readiness; separate paid invoice effects from modeled quota-tier replay                 | Pending; do not deliberately exhaust free starts                                                       |
| Staging adoption              | Pinned artifact, explicit new idle-policy admission, same-host reuse past one hour, durable save and source-deleted replacement, retained filesystem/session/output | Pinned client implementation published; opt-in activation/hosted check pending                         |
| Publication and cleanup       | Main runtime/client CI, finite evidence report, positive absence for owned test hosts, retained checkpoint references and unchanged protected fixtures              | Pending                                                                                                |

## Execution order and stop rules

1. Implement the coherent lifecycle policy and integration first. Run affected
   deterministic tests and required root checks; avoid broad hosted requalification.
2. Freeze one candidate and one workload trace. Use two matched replicas against
   the current fixed policy, exercising continued reuse across an hour and a
   genuinely unused interval. Observe existing operation IDs after uncertainty.
   A timing observation timeout never authorizes duplicate work or allocations.
3. Reuse valid archive, transport, interactive and business-workflow evidence.
   Run one final scoped staging save/reuse/replacement sequence. Fix concrete
   failures and repeat only affected checks, not the whole matrix.
4. Publish actual results and limits. Do not promise a particular reuse factor,
   universal savings or absolute zero loss. Complete only after staging, exact-SHA
   CI and owned cleanup pass; report closed gates, not invented percentages.

## Current state and recovery

Baseline: runtime `d386b92052c1d03c100854ee4585c56774b50948`, qualification34;
client `f641ebe0208f56b89ca29ba39b0b70ad375294f0`. Both exact-SHA CI runs passed.
Prior qualification ended with zero active provider hosts and all89 conservatively
accounted performance hosts retired. The old approved aggregate experiment cap
was10 dollars; it remains separate from any new allowance.

The one-hour allocation bound is in the core pool and Boat adapter; ten-minute
retention is checked by both pool retirement and manager maintenance. Those
checks must be unified around persisted decisions, not changed independently.
Initial implementation uses fixed absolute leases; renewal is not required.

Current local implementation adds validated lifecycle/price contracts, bounded
return-history economics, per-slot policy/deadline snapshots, queue-versus-idle
retirement fencing and maintenance deadlines. Boat/SSH advertise bounded lease
capabilities; CLI accepts opt-in lifecycle configuration. Existing hosts keep their
original deadlines and legacy fixed semantics. Uncertain allocation retries stop
within23 hours even when the physical lease lasts24 hours, leaving margin inside
the provider's documented idempotency retention window. Defaults remain one hour/ten minutes.
All278 TypeScript checks plus build/types/lint pass. Host Python assets are unchanged.

A separate additional10-dollar allowance was requested for at most24 starts with
eight-hour maximum leases (conservative full-lease/start bound8.60 dollars). It is
pending; no live allocation or other paid qualification has started for this goal.

The Boat pricing adapter and standalone composition are implemented. Effective
quotes refresh outside transactions with durable cache/backoff and stale-completion
fences; unavailable pricing falls back without preventing reconciliation. The
client's shared configuration now accepts an explicit lifecycle profile, with
runtime admission and composition still to wire.

Two matched replicas are prepared against the frozen prior/current artifacts:51
sessions90 seconds apart crossing75 minutes, then25 unused minutes and a final
restore. The driver checks the separate allowance before credentials or network,
persists stable operations and allocation grants, counts real provider/storage
requests and payloads, compares an independent filesystem oracle each cycle, and
requires durable final save before owned retirement. Import/hash/approval guard
checks pass without network or allocations. Its hosted behavior is not yet qualified.

Next: finish client main CI, obtain the separately requested allowance, reconcile
current inventory and queued work, then run the frozen comparison and scoped
staging opt-in/reuse/source-deleted recovery. Do not repeat unchanged archive or
interactive matrices. Private receipts remain in the operator's local QA state.
