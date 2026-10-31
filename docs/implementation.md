# Implementation plan

## Objective

Build an independent MIT-licensed `firtoz/jetski`: portable, durable sandboxes on
reusable compute, with a TypeScript core/SDK, optional standalone server and CLI.
Complete the [v1 design and scope](design.md), qualify its durability and isolation,
then integrate a downstream client in staging using a pinned commit. The full
release goal remains active; passing one fixture does not complete it.

## Read selectively

- [Design and scope](design.md): architecture, supported adapters and lifecycle contracts.
- [Qualification evidence](qualification.md): verified results, consequential failures and limits.
- [Standalone guide](standalone.md): operator configuration and experimental capabilities.
- [OpenAPI](openapi.json): implemented versioned routes.

Read this plan when resuming. Open other documents only for the area being changed.
Inspect the worktree and exact-SHA CI before trusting a recorded result.

## Constraints

- Public content stays generic; application and coding-agent integrations stay client-side.
- No paid hosts without a separate allowance; no purchases, top-ups or use of the
  separately reserved recovery budget. No operator-desktop runtime changes.
- Preserve the separate November 1, 2026, 12:20 UTC real-grace GC experiment:
  do not change its clock, checkpoint references, active generation or reservation.
- No production cutover, npm publication or public hosted-compute offering.
- Preserve acknowledged checkpoints and one authoritative writer during adoption;
  start with new staging workspaces. Keep legacy migration in the client.
- Uncertain saves retain/quarantine the source. No unverified release, silent
  history expiry, cross-owner host reuse or cross-owner deduplication.

## Acceptance status

Evidence scope matters: disposable SSH/Podman tests do not prove live Boat,
physical-host replacement, remote-store parity or downstream staging behavior.

| Gate                             | Current evidence                                                                             | Remaining acceptance                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Independent repository           | Public MIT source, separate exports, standalone examples and CI                              | Final provenance/package independence audit                                          |
| Core lifecycle and pooling       | Replay/fencing tests; real API stop/resume, warm reuse, held/historical restore, idle expiry | Full restart/placement matrix and matched hosted runs                                |
| Execution and interactive access | Commands/output, PTY/SSH/TCP; Chrome HTTPS/container HTTP/WSS                                | Finish active-stream stop/recovery regression and remaining lifecycle audit          |
| Filesystem and checkpoints       | Exact archive fixtures; incremental/local-cache and source-deleted recovery tests            | Both providers/stores qualified under matched recovery conditions                    |
| Storage and collection           | Local/S3 contracts, R2 functional evidence, fault/race tests                                 | Remote end-to-end recovery and real-grace collection gates                           |
| Security                         | Owner/fence/credential isolation and cleanup checks                                          | Final capability and lifecycle isolation audit                                       |
| Client integration               | Agreed staging-only adoption design                                                          | Implement client adapters, pinned dependency, real workflow and replacement recovery |
| Benchmarks and release           | Per-fixture measurements and preserved failures                                              | Matched comparison, owned-resource cleanup, documented limits and green final CI     |

## Current work

The active-stream stop test exposed a real ordering problem: runtime stop could
kill a command supervisor before its authenticated completion was persisted.
The fix closes admission and drains cancellation receipts before stopping the
container. The API regression passes, but the SSH worker-loss test caught a separate
issue: physical cleanup must remain possible without changing an uncertain command
into a successful outcome. That correction passes local checks and awaits CI.
See [the failure and recovery record](qualification.md#active-stream-stop-regression).

## Next steps

1. Qualify the corrected quiescence path on exact-SHA CI; retain both failures.
2. Audit remaining lifecycle/replacement requirements against existing tests;
   add checks only for uncovered requirements or concrete defects.
3. Finish provider/storage qualification and prepare the downstream staging adapter.
   Obtain a separate allowance before paid-host experiments.
4. Run matched hosted benchmarks, staging workflow and replacement recovery;
   complete the acceptance audit before marking the goal achieved.

## Keeping this plan useful

Keep this file short (roughly 100 lines). Replace current status; do not prepend
continuation logs. Put durable design in design.md, consolidated evidence in
qualification.md, and operator instructions in standalone.md. Private receipts,
process handles, temporary paths and routine test output belong in the local QA
scratchpad. Preserve consequential failures in the evidence table and Git history,
without copying entire logs into documentation. Do not reread historical notes on
every continuation.
