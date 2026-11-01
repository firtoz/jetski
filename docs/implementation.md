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

| Gate                             | Current evidence                                                                             | Remaining acceptance                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Independent repository           | Public MIT source; artifact content audit and dependency-denying portable import tests pass  | Repeat provenance/package audit for the final release artifact                    |
| Core lifecycle and pooling       | Replay/fencing tests; real API stop/resume, warm reuse, held/historical restore, idle expiry | Full restart/placement matrix and matched hosted runs                             |
| Execution and interactive access | Commands/output, PTY/SSH/TCP; Chrome HTTPS/container HTTP/WSS                                | Remaining interactive lifecycle/provider audit                                    |
| Filesystem and checkpoints       | Exact archive fixtures; incremental and source-deleted recovery tests                        | Complete provider/store and client integration qualification                      |
| Storage and collection           | Local/S3 contracts, R2 functional evidence, fault/race tests                                 | Remote end-to-end recovery and real-grace collection gates                        |
| Security                         | Owner/fence/credential isolation and cleanup checks                                          | Final capability and lifecycle isolation audit                                    |
| Client integration               | Pinned artifact; live read/edit/publication, source-deleted recovery and resumed work pass   | Browser UI, remaining interactive/lifecycle audit and final rollout qualification |
| Benchmarks and release           | Per-fixture measurements and preserved failures                                              | Matched comparison, owned-resource cleanup, documented limits and green final CI  |

## Current work

Live Boat/R2 qualification covers warm reuse, incremental saves, idle-host loss,
physical replacement, exact filesystem recovery and owned-resource cleanup.
Standalone terminal, SSH, HTTP/WebSocket preview and TCP evidence is recorded in
[qualification.md](qualification.md). Matched whole-workload measurements remain
required; focused improvements do not establish a universal speedup.

The downstream staging read/edit/publication workflow passes with the pinned
artifact. Source-deleted replacement matches 156 filesystem entries and
322,806,090 bytes, including modes and symlinks. Resumed work retains the original
session and confirms the published revision with a clean tree. Live embedded
terminal input/replay, binary HTTP/WebSocket preview, timed access
revocation and durable release now pass. Browser UI, hosted restart/rollback checks
and final rollout remain open.

Portable HTTP and WebSocket transports now pass binary/failure tests and local
Workers probes. A Fetch preview gateway reuses durable preview sessions, enforces
isolated origins and cookie authentication, and aborts active streams on revocation.
SQLite-backed tests and the combined authenticated Workers HTTP/WebSocket probe
pass, including revocation. Live embedded transport qualification now passes; browser UI remains unverified. See [runtime limits](runtime.md#embedded-preview-compatibility).

Podman is the only supplied runtime. Explicit FUSE-overlay bootstrap is qualified;
changing immutable host assets still requires draining old assignments. Remaining
runtime gates include alternate-bootstrap capability auditing, slow-storage and
host-lifetime headroom checks. Uncertain work retains its journal and source;
recovery selects acknowledged checkpoints without claiming unpublished changes.

Real-grace collection, matched benchmarks, final provenance/isolation audits,
main CI and owned-resource reconciliation remain release gates. Preserve the
separate recovery experiment and budget while completing them.

## Execution order

The finite [implementation closure checklist](implementation-checklist.md) tracks
source audit and concrete code gaps separately from release verification.

Finish implementation before broad release qualification. First audit the approved
v1 contracts against current source and keep a finite list of missing behavior;
implement those gaps with targeted checks. Do not add optional performance work or
expand the acceptance matrix without a concrete missing requirement or observed
failure. Then freeze the candidate artifact and execute one consolidated acceptance
pass, reusing valid existing evidence. Fix failures and repeat only affected checks.
The already-running hosted comparison may finish and must clean its owned hosts.

## Next steps

1. Implementation candidate: public runtime `ad1f5e5`, qualification artifact 18,
   and the published client pin/idle-maintenance integration. The finite source
   checklist has implementations for all approved v1 areas; release acceptance is open.
2. Execute one consolidated pass using the existing acceptance matrix and prior
   valid evidence: exact-SHA CI, active browser interaction, lifecycle/isolation,
   replacement recovery, real-grace GC, package provenance and cleanup accounting.
3. Fix observed failures or omitted approved contracts, repeat affected checks,
   then close the acceptance matrix. Do not add optional implementation or tuning.
4. The equal-resource twenty-trial benchmark is complete; all recovery checks passed
   and owned hosts are retired. Preserve the [measured limits](benchmarks.md).

## Keeping this plan useful

Keep this file short (roughly 100 lines). Replace current status; do not prepend
continuation logs. Put durable design in design.md, consolidated evidence in
qualification.md, and operator instructions in standalone.md. Private receipts,
process handles, temporary paths and routine test output belong in the local QA
scratchpad. Preserve consequential failures in the evidence table and Git history,
without copying entire logs into documentation. Do not reread historical notes on
every continuation.
