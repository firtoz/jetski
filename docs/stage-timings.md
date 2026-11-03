# Optional stage diagnostics

`ManagerOptions.timings` accepts a best-effort synchronous callback with
`{stage, elapsedMs, outcome}`. Durations use a monotonic clock. The portable core
measures host control, cached resume, transfer/publication, pre-cleanup verification
and storage operations without importing a provider or filesystem module.
`observeCheckpointStore` is also available independently from `jetski/core`.

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

## Experimental combined quiesce/capture

`ManagerOptions.eagerCheckpointCapture: true` asks the host to capture immediately
after stopping execution, in the same control request. Default behavior remains
separate quiesce and capture. A host without the optional receipt falls back to
ordinary capture. This is a contract-based core optimization, independent of host
provider or storage adapter; it is not required of third-party runtimes.

The stopped archive receipt is validated and persisted before retaining output and
publishing the checkpoint. Output/stream/input settlement still gates publication;
remote object verification still gates destructive cleanup. Unknown outcomes keep
the source fenced. The option saves one control round trip when supported, but can
lose overlap between capture and retained-output uploads. Workloads with large
command outputs may prefer the existing path. Hosted measurements determine the
recommendation; fewer calls alone do not prove lower end-to-end latency.

Rust extraction also uses a single bounded 1 MiB scratch buffer shared across files.
It preserves complete compressed-hash/CRC validation, short-read rejection, final
metadata/fsync and private staging publication. Neither optimization relaxes the
checkpoint durability boundary or enables unverified writable cache reuse.
