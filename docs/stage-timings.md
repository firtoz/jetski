# Optional stage diagnostics

`ManagerOptions.timings` accepts a best-effort synchronous callback with
`{stage, elapsedMs, outcome}`. Durations use a monotonic clock. The portable core
measures host control, cached resume, transfer/publication, pre-cleanup verification
and storage operations without importing a provider or filesystem module.
`observeCheckpointStore` is also available independently from `@firtoz/jetski/core`.

A Boat transport can receive the same `timings` option. This explicitly enables
host diagnostics through its trusted control environment and reports allowlisted
host spans. Python and Rust report archive capture, archive restore, extraction
and sync/publication, container creation and cache publication. Default transports
emit none of these diagnostics. Host wire results and durable journals are unchanged.
An embedded SSH transport may set the same trusted `JETSKI_HOST_TIMING=1` execution
environment and parse bounded stderr with `observeHostTimings`; it must retain its
existing forced-command authorization boundary.

Spans are nested and may overlap: **do not add all durations together**. For example,
`archive.extract` and `archive.sync_publish` are inside `archive.restore`, which is
inside cached-resume control. Storage streaming times include consumer backpressure.
CPU samples need an independent process observer; these durations are wall time,
not CPU or filesystem device latency. Native host spans report `observed` on scope
exit; the authenticated enclosing control result determines success. Timing output
never authorizes publication, release or command replay.

Sink failures/rejected promises do not change results. Keep sinks short and enqueue
observations locally; do not block lifecycle work on an external telemetry service.
Records contain fixed stages and durations, never paths, command payloads, output,
credentials or exception text. Malformed/unrecognized host stderr is discarded.
Use caller-owned correlation context to associate records with an operation.

## Committed lifecycle events

`ManagerOptions.events` or `observeLifecycle(state, sink)` from `/core` emits
committed phase changes with owner/sandbox, generation and operation identity.
Do not wrap a store twice. `elapsedMs` covers durable admission to phase; payloads,
output, error text, filesystem contents and credentials are excluded. Use a short
nonblocking queue. Events are best effort and can be lost at crash/uncertain commit;
persisted outcomes remain the authority for recovery or billing.

For combined capture, concurrency and inline output choices, see
[advanced configuration](advanced-configuration.md) and
[measured host stages](../maintainer/benchmarks/host-stages.md).
