# Implementation closure

This is the finite source audit for the approved [v1 scope](design.md). Source
presence and release verification are separate. Close each pending audit by reading
the actual entry points and their lifecycle dependencies; only add work for a
missing approved contract or a concrete defect.

| Area                                                  | Source inspected                                             | Implementation status                                                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable lifecycle, placement, stop/checkpoint, resume | core/manager.ts, shutdown.ts, operations.ts, pool.ts         | Present; final failure-path audit pending                                                                                                                                              |
| Host adapters and runtime                             | providers/boat.ts, providers/ssh.ts, host/runtime_backend.py | Present; bootstrap/capability and cleanup audit pending                                                                                                                                |
| Files, commands, terminals, forwarding                | core modules, sdk.ts, server/http.ts                         | Typed SDK lifecycle/command entry points added; server owner/replay checks pass; final OpenAPI parity audit pending                                                                    |
| Incremental storage and verified publication          | core/checkpoints.ts, transfer.ts, storage/s3.ts              | Present, including conditional verification and persisted resource limits                                                                                                              |
| GC reachability and fencing engine                    | core/checkpoints.ts, inventory.ts                            | Present                                                                                                                                                                                |
| Standalone timed collection                           | server/http.ts startWorker, core/manager.ts reconcile        | Implemented opt-in durable cadence in core/maintenance.ts; worker calls manager.maintain; restart/fencing, real-collector retained-byte and server checks pass; implementation present |
| Embedded scheduling                                   | contracts.ts Scheduler, external reconciliation entry point  | Client transaction/alarm and restart paths present; add next-maintenance deadline integration when updating client pin so stopped sandboxes retain GC wakeups                          |
| Identity, owner scope and preview gateways            | server/http.ts, preview modules, ssh.ts                      | Entry points present; policy/capability audit pending                                                                                                                                  |
| Portable package, SQLite/local/S3 composition         | package exports, state/sqlite.ts, server configuration       | Present; final import and artifact audit is release verification                                                                                                                       |
| Staging client integration                            | External client adapter and pinned artifact                  | Existing implementation; update pin after implementation freeze, audit rollback ownership                                                                                              |

## Work order

1. Finish the pending source audits above and turn concrete omissions into a
   bounded implementation list.
2. Implement durable standalone collection orchestration and any other identified
   omissions, with targeted checks. Preserve grace, retention and fencing rules.
3. Freeze a candidate only when every implementation row is closed.
4. Run the existing release acceptance matrix once, reusing valid prior evidence.
   Performance tuning beyond observed release failures is deferred.
