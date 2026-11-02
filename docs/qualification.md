# Qualification evidence

The original v1 baseline acceptance includes the completed real-grace collection
and retained-byte recovery check. Subsequent performance changes have their own
[active qualification](goals/checkpoint-performance.md). The baseline checklist is
[implementation.md](implementation.md); design and exclusions are in [design.md](design.md).

## Qualified baseline and independent checks

Runtime `7240e47`, distributed as experimental qualification artifact 19, passes
build, typecheck, lint and all 187 local tests.
[Exact-runtime CI](https://github.com/firtoz/jetski/actions/runs/41332633249)
passes all seven jobs: TypeScript/Python, rootless runtime, standalone API, and
SSH/Boat control fixtures with default and FUSE-overlay storage. Boat fixture jobs
emulate provider APIs on disposable Linux; live Boat evidence is separate below.

All 156 packaged files match source/build and both installed downstream consumers.
Host assets are unchanged from the previous candidate. Portable import tests reject
unwanted host/database dependencies. The MIT source has one independent history
root; source, examples and commit messages pass the generic-content audit. See
[NOTICE](../NOTICE) for provenance and dependency-license boundaries.

| Contract                          | Evidence                                                                                                                             | Scope                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Lifecycle, operations and pooling | SQLite replay/restart, lost acknowledgements, stale fences, queued cancellation; live warm reuse and idle expiry                     | Uncertain outcomes remain explicit; no blind replay                                   |
| Host/runtime isolation            | Rootless Podman and SSH/API qualification, namespace/cgroup checks, owner/image/resource policy tests                                | Linux x86-64; one assignment per host, no cross-owner reuse                           |
| Filesystem integrity              | Host archive/fencing tests; exact live independent oracles and source-deleted replacement                                            | Bytes, modes, symlinks and within-mount hardlinks; no RAM/kernel snapshot             |
| Storage adapters                  | Shared local/S3 consistency and failure contracts; isolated R2 conformance and live filesystem recovery                              | Other S3-shaped services require their own qualification                              |
| Incremental publication and cache | Changed-frame saves, corrupt/cache-miss recovery, lost publication ACK, conditional-read failure tests and live cache receipt        | Cache reuse follows verified durable publication; fresh clients hash complete objects |
| Retention and collection          | Pin/history tests; writer/reader/publication races, corrupt/incomplete listing and failed-delete cases                               | Actual 24-hour retired-only deletion, replay and retained restore pass below          |
| Interactive transports            | Real PTY/SSH/TCP qualification, Chrome HTTPS/WSS fixture, portable Workers gateway probes and live downstream browser check          | Authenticated scope, bounded bytes, input identities and output cursors               |
| Embedded state/scheduling         | Actual SQLite-backed platform restart/alarm/rollback tests; live deployment preserves checkpoint, generation and closed-access state | Client supplies transactional state and authoritative scheduling                      |
| Adoption and recovery             | Real read/edit/publication, source-loss and interrupted-placement recovery, physical replacement and resumed work                    | New staging workspaces; persisted backend identity rejects competing/native targets   |

The source and tests for creation admission, terminal attachment, checkpoint
history and preview sessions are under `test/`. Runnable qualification programs
include `examples/qualify-api.ts`, `qualify-checkpoint-storage.ts`,
`qualify-filesystem-storage.ts` and `qualify-filesystem-gc.ts`. Mock and local checks
are not promoted to live-provider evidence.

## Final live Boat/R2 and browser pass

A deleted-source replacement restored **167 entries and 322,866,475 bytes** with an
independent byte/mode/link oracle identical to the source. This particular tree had
no hardlink groups; earlier filesystem fixtures exercise hardlinks. The broader
read/edit/publication workflow also passed physical replacement and resumed work,
retaining its original session and clean published revision.

The actual browser terminal accepted input. Applied resizing changed its geometry
from 22 rows / 102 columns to 22 rows / 88 columns. The authenticated embedded
preview displayed exact six-byte HTTP and WebSocket echo results. A page reload
restored terminal history and accepted a new command on the same access identity;
the fixture command was not replayed.

Explicit close published an unchanged archive: **154,551,473 compressed bytes**,
SHA-256 `5509dd62277f98f528c7ed534184f03a8b48d25a806d53f2e4378d4f605cbaf7`.
Access and its business reservation were released. Final inspection found no
workload/monitor processes, assignment mounts, assignment data directory or upload
file. Both the prior source and final replacement were retired with provider
absence confirmed; final provider inventory reported zero active hosts.

The installed command watchdog also passed on that Boat host: after killing its
control process, its independent deadline terminated the child and TERM-resistant
descendant. Existing bounded-output and nonzero-exit assertions passed too. The
provider reported a bounded 3,599-second host lifetime.

Earlier live embedded checks cover same-input replay with one execution,
authenticated binary HTTP/WebSocket traffic and server-owned expiry. An established
stream closed 121 ms after its deadline; the expired cookie received 403. Historical
uncertain outcomes, including cancelled stream delivery, remain preserved after
cleanup and host retirement. They are not silently reclassified as successful work.

## Real-grace collection: passed

The independent R2 fixture became eligible on November 1, 2026, at 23:51:52 UTC.
At November 2, 00:01:46 UTC, the frozen baseline collector deleted its single
eligible retired frame. Early collection had deleted nothing. Repeating the same
collection ID returned the persisted outcome without a second deletion.

With source archives already deleted, a fresh download and full hash checks
recovered the pinned retained version. The independent filesystem oracle matched
bytes, modes, links, Unicode and rename/delete results. Scoped fixture payloads
and local test state were then cleaned; permanent identity reservations remain.
The original clock, references and generation were not changed. No VM was used;
physical-host replacement remains separately qualified above.

This proves the baseline fixture's real-time grace boundary. It does not establish
real-grace qualification for every later format or enable wider automatic
collection. The separate protected experiment remains independent.

## Measured limitations

- Both twenty-trial hosted comparisons completed with exact recovery and owned
  hosts retired. The equal-resource comparison found slower saves and faster
  resumes for its fixture. Full numbers and measurement boundaries are in
  [benchmarks.md](benchmarks.md); there is no universal speedup claim.
- The large downstream archive took roughly 8–13 minutes to reach cold access
  readiness in two observed runs. These were not matched cold-start trials.
- Podman monitor processes remained for several minutes after workload removal;
  final retirement waited for observed drain. Immediate monitor cleanup is not
  established by these results.
- FUSE-overlay bootstrap passes disposable-host fixtures; live cloud qualification
  uses the default storage selection. FUSE remains experimental.
- Local checkpoint storage cannot recover from loss of its control-plane disk.
  Remote storage is required for that durability boundary.
- No production cutover, other provider support, universal zero-loss guarantee or
  public hosted-compute readiness follows from this qualification.

## Consequential failures and history

Observed failures led to bounded process-group watchdogs, explicit missing-source
and interrupted-placement recovery, native-fetch portability fixes, portable
preview transports and precise terminal-input absence handling. A late maintenance
regression now rotates an older attempt only after an authoritative forward
fence advance; regression and race checks pass. Initial live fixture and harness
failures remain excluded from successful performance trials.

[The earlier detailed qualification log](https://github.com/firtoz/jetski/blob/a36444a703069add3cb28deeea66629ed138a4a5/docs/qualification.md)
preserves individual failures, CI links and historical evidence boundaries. It is
not the current acceptance checklist. Routine receipts, private configuration and
process handles remain outside the public repository.
