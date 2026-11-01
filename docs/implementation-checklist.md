# Implementation closure

This is the finite source audit for the approved [v1 scope](design.md). Source
presence and release verification are separate. Close each pending audit by reading
the actual entry points and their lifecycle dependencies; only add work for a
missing approved contract or a concrete defect.

| Area                                                  | Source inspected                                             | Implementation status                                                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable lifecycle, placement, stop/checkpoint, resume | core/manager.ts, shutdown.ts, operations.ts, pool.ts         | Implemented lifecycle, durable operation replay and fenced shutdown/recovery; final failure matrix is release verification                                                             |
| Host adapters and runtime                             | providers/boat.ts, providers/ssh.ts, host/runtime_backend.py | Podman-only selection, namespace/cgroup readiness, restricted mounts/capabilities, fenced quiesce and observed removal paths inspected; live cleanup remains qualification             |
| Files, commands, terminals, forwarding                | core modules, sdk.ts, server/http.ts                         | OpenAPI route inventory covers v1 lifecycle, commands/output, files/uploads, history/pins, terminals, ports/previews and recovery; typed SDK entry points present                      |
| Incremental storage and verified publication          | core/checkpoints.ts, transfer.ts, storage/s3.ts              | Present, including conditional verification and persisted resource limits                                                                                                              |
| GC reachability and fencing engine                    | core/checkpoints.ts, inventory.ts                            | Present                                                                                                                                                                                |
| Standalone timed collection                           | server/http.ts startWorker, core/manager.ts reconcile        | Implemented opt-in durable cadence in core/maintenance.ts; worker calls manager.maintain; restart/fencing, real-collector retained-byte and server checks pass; implementation present |
| Embedded scheduling                                   | contracts.ts Scheduler, external reconciliation entry point  | Implemented transactional client alarms plus core maintenance deadlines; stopped-controller restart regression passes                                                                  |
| Identity, owner scope and preview gateways            | server/http.ts, preview modules, ssh.ts                      | Bearer owner scope, public-key SSH scope, isolated-origin preview sessions and configured capability routing inspected; live isolation remains verification                            |
| Portable package, SQLite/local/S3 composition         | package exports, state/sqlite.ts, server configuration       | Present; final import and artifact audit is release verification                                                                                                                       |
| Staging client integration                            | External client adapter and pinned artifact                  | Qualification artifact 19 pinned in both consumers; idle maintenance integrated; persisted backend selection and admission rollback paths inspected                                    |

## Work order

1. Freeze the current implementation candidate: public runtime commit `7240e47`
   and the client artifact-19 integration after publication.
2. Run the existing release acceptance matrix once, reusing valid prior evidence.
3. Reopen implementation only for an observed failure or an omitted approved
   contract; performance tuning beyond release failures stays deferred.

All source rows now have implementations. This is an implementation candidate,
not a claim that release acceptance or every supported-provider behavior passes.
Automatic collection remains opt-in until its real-grace release gate closes.
