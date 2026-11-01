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

| Gate                             | Current evidence                                                                             | Remaining acceptance                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Independent repository           | Public MIT source, separate exports, standalone examples and CI                              | Final provenance/package independence audit                                      |
| Core lifecycle and pooling       | Replay/fencing tests; real API stop/resume, warm reuse, held/historical restore, idle expiry | Full restart/placement matrix and matched hosted runs                            |
| Execution and interactive access | Commands/output, PTY/SSH/TCP; Chrome HTTPS/container HTTP/WSS                                | Remaining interactive lifecycle/provider audit                                   |
| Filesystem and checkpoints       | Exact archive fixtures; incremental and source-deleted recovery tests                        | Complete provider/store and client integration qualification                     |
| Storage and collection           | Local/S3 contracts, R2 functional evidence, fault/race tests                                 | Remote end-to-end recovery and real-grace collection gates                       |
| Security                         | Owner/fence/credential isolation and cleanup checks                                          | Final capability and lifecycle isolation audit                                   |
| Client integration               | Pinned artifact and downstream lifecycle adapters; scoped live qualification begun           | Complete client workflow and replacement recovery through the pinned dependency  |
| Benchmarks and release           | Per-fixture measurements and preserved failures                                              | Matched comparison, owned-resource cleanup, documented limits and green final CI |

## Current work

Live Boat/R2 qualification now passes same-host restore and physical replacement
with an exact filesystem oracle, followed by both host retirements and scoped
object cleanup. This baseline downloads checkpoints from remote storage.
Verified local-cache reuse passes all five disposable CI jobs on its development
branch and the live warm-restore oracle. Live terminal controls, binary forwarding
and replacement-host R2 restore passed, including final host retirement and owned
object cleanup. Confirmed idle-host disappearance now also passes live Boat/R2
replacement with exact bytes, modes and links; both test hosts were retired.
Explicit operator-selected outbound networking passed all five CI jobs, including
real outbound access and host-loopback denial on a disposable rootless host.
Networking stays disabled by default; broader destination filtering is external.
Embedding support and built-package consumption passed CI, and initial
client-side state/storage and lifecycle adapters pass local contracts. After the
native edge fetch correction, scoped hosted preparation executed and published a
checkpoint matching an independently observed source-archive identity; its host was
retired. Full downstream workflow and filesystem replacement proof remain open.
Bounded parallel range reads passed a focused live comparison; whole-workload
measurements remain required. The separate paid-host allowance is approved.
Optional lifecycle observations report redacted phases and timings. Remaining gates
include real-grace collection, matched hosted measurements and staging integration.
Explicit recovery after confirmed host loss covers interrupted saves and placements
with local restart and HTTP/SDK fault tests. A hosted selected checkpoint also
passed an independent filesystem comparison; container startup and the complete
downstream workflow remain open. Recovery retains the original uncertain outcome,
selects acknowledged data and discloses unavailable unpublished changes.
Host runtime composition now has explicit lifecycle/execution contracts shared by
control, command workers and forwarding. Podman remains the only supplied backend;
runtime-specific readiness probing is injectable, while alternate bootstrap
capability negotiation and the full runtime conformance audit remain open.
New command admission reserves the existing checkpoint drain interval before host
expiry; measured save headroom and full hosted lifetime qualification remain open.
An explicit authenticated stream crypto suite passes a local embedded-runtime
encrypted binary round trip; full client transport wiring and hosted checks remain open.
See [qualification evidence](qualification.md).

## Next steps

1. Finish the remaining remote/provider recovery gates; idle-host disappearance now passes a live oracle.
2. Audit remaining lifecycle/replacement requirements against existing tests;
   add checks only for uncovered requirements or concrete defects.
3. Finish provider/storage qualification and prepare the downstream staging adapter.
   Stay within the separately approved paid-host allowance.
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
