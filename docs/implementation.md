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

| Gate                             | Current evidence                                                                                              | Remaining acceptance                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Independent repository           | MIT source; portable imports; 156-file artifact and consumers match                                           | Final consolidated publication                                        |
| Core lifecycle and pooling       | SQLite replay/fencing/restart; live warm/idle, source/placement loss and final replacement                    | Verified for current v1 matrix                                        |
| Execution and interactive access | Standalone PTY/SSH/TCP; real browser input/resize/reconnect, authenticated HTTP/WSS; hosted watchdog          | Verified for current v1 matrix                                        |
| Filesystem and checkpoints       | Byte/mode/link fixtures; final 167-entry / 322,866,475-byte replacement; unchanged durable publication        | Verified for current v1 matrix                                        |
| Storage and collection           | Local/S3 contracts; live R2; corruption, listing and reader/writer races                                      | Verified baseline real-grace deletion/replay/restore                  |
| Security                         | Owner/fence/credential isolation; bootstrap fixture CI; final process/mount/data cleanup and provider absence | Verified within documented scope                                      |
| Client integration               | Pinned artifact; actual read/edit/PR, recovery and browser workflow; deployed restart and backend guards      | Final evidence publication                                            |
| Benchmarks and release           | Both twenty-trial comparisons, green runtime/client CI, owned hosts retired                                   | Baseline matrix and timed gate complete; follow-on tracked separately |

## Qualified baseline and follow-on work

Runtime `7240e47`, qualification artifact 19: build, typecheck, lint and all 187
local tests pass. [Runtime CI](https://github.com/firtoz/jetski/actions/runs/41332633249)
passes all seven jobs, including default and FUSE-overlay SSH/Boat fixtures.
Host assets are unchanged from the preceding qualified candidate. The artifact
and both installed consumers match all 156 files; the public tree contains no
application or coding-agent references.

The pinned client completes real read/edit/PR and source-deleted recovery, retaining
its session and clean published revision. The final independent replacement
comparison matches 167 entries and 322,866,475 bytes. Browser input, applied resize,
page reconnect and exact authenticated HTTP/WebSocket byte echoes pass. The typed
missing-input mapping fix is deployed and qualified.

Explicit close published the unchanged archive and released access. Final host
inspection found no workload/monitor processes, assignment mounts, data directory
or upload file. The owned source and replacement were retired with provider absence
confirmed; final inventory reports zero active hosts. The installed watchdog also
passes control-process death and descendant cleanup on Boat. Historical uncertain
outcomes remain preserved; they are not reclassified as successful execution.

Both matched comparisons and owned-host cleanup are complete. The equal-resource
run found slower saves and faster resumes for its fixture; see
[measured limits](benchmarks.md). The large client checkpoint also exposed slow
cold restore. These results do not establish universal speedups or zero-loss guarantees.

The independent real-grace fixture passed on November 2 at 00:01:46 UTC,
after its unmodified November 1, 23:51:52 UTC eligibility boundary. Retired-only
deletion, same-operation replay, exact source-deleted retained recovery and scoped
cleanup passed without a VM. See [qualification](qualification.md#real-grace-collection-passed).
The separately protected experiment remains independent.

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

The original v1 baseline and the [checkpoint performance goal](goals/checkpoint-performance.md)
are qualified. Qualification34 completes the matched warm comparison, large cold
recovery and pinned staging save/warm/source-deleted replacement with owned cleanup.
Reuse that evidence for unchanged paths instead of repeating the completed matrices.

Qualification 35 adds opt-in longer leases and cost-aware idle retention. The
[matched lifecycle report](host-lifecycle-benchmarks.md) records fewer physical
starts and lower idle compute alongside slower ordinary warm operations. Scoped
staging beyond-hour use and source-deleted recovery passed with owned cleanup.
The [lifecycle goal](goals/adaptive-host-lifecycle.md) records the completed scope;
existing checkpoint and real-grace fixtures remain preserved.

The opt-in [Rust host comparison](rust-host-benchmarks.md) completed twenty timed
cycles, two exact source-deleted recoveries and native interactive qualification.
All eight owned hosts are absent. Python stays the default: no consistent speed
win was measured. The [goal](goals/rust-host.md) records the completed finite scope.

The [host-stage comparison](host-stage-benchmarks.md) completed forty valid
cycles, both exact candidate replacements and safe recovery from one R2 HTTP502.
All ten owned hosts are absent. It found no repeatable end-to-end candidate win;
Python and separate capture remain defaults. [Completed scope](goals/host-stage-performance.md).

The [optional gVisor runtime goal](goals/gvisor-runtime.md) adds a separately
selected runtime and coordinated memory resume, retaining R2 filesystem recovery
and Podman defaults. Its thirty-sample comparison, real memory continuity and both source-deleted R2
recoveries pass; see [measurements and limits](gvisor-benchmarks.md). All eight
owned hosts are absent.

The [portable memory checkpoint goal](goals/portable-memory-checkpoints.md) extends
optional process recovery to remote memory artifacts, compression/chunk reuse and
source-deleted host replacement. See its [dedicated report](portable-memory-benchmarks.md)
for the finite comparison, recovery evidence and documented limitations.

## Keeping this plan useful

Keep this file short (roughly 100 lines). Replace current status; do not prepend
continuation logs. Put durable design in design.md, consolidated evidence in
qualification.md, and operator instructions in standalone.md. Private receipts,
process handles, temporary paths and routine test output belong in the local QA
scratchpad. Preserve consequential failures in the evidence table and Git history,
without copying entire logs into documentation. Do not reread historical notes on
every continuation.
