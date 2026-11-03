# Optional gVisor runtime

This is active implementation work. The optional Python host path can be selected
for qualification, but native operation is not yet qualified. Managed memory resume and explicit
filesystem fallback are implemented with targeted restart/ACK-loss tests. Podman remains the supported default. The [goal](goals/gvisor-runtime.md) tracks
the finite integration, benchmark and recovery gates.

## Composition

Machine allocation, runtime isolation and durable storage remain separate. The
planned adapter uses native `runsc`, caller-managed unprivileged user namespaces,
subordinate workload IDs, private network namespaces and enforced cgroup limits.
Image preparation can reuse the existing OCI image tooling; this does not make
Podman's execution journal authoritative for a separately restored runsc process.
Unsupported host capabilities must fail admission rather than weaken isolation.

The initial platform is Linux x86-64 with `systrap`. The installer pins the entire
upstream `release-20261102.0` archive, including adjacent `gvisor-bin` sidecars;
checks its SHA-256 before extraction; rejects links, devices, traversal and
archive expansion beyond its bounds; and installs in a separate immutable
root-owned directory. It changes no global container-runtime default.

[gVisor's simple rootless mode](https://gvisor.dev/docs/user_guide/rootless/)
does not implement checkpoint/restore. The adapter must prove caller-managed
namespace support instead. It must also prove effective resource limits rather
than accepting ignored cgroup errors. Python host composition comes first;
an unsupported host implementation/runtime pair must be rejected explicitly.

## Filesystem stop and memory suspend

Ordinary checkpoint/stop preserves declared filesystem paths and terminates
processes. Memory suspend is a distinct, capability-gated operation:

1. Refuse unresolved commands, open terminal/forwarding streams and file uploads.
   Background workload processes can remain inside the isolated runtime.
2. Persist the operation and close its generation before native checkpointing.
   Checkpoint completion must be followed by independently observed quiescence.
3. Checksum native memory artifacts immediately after freezing. Capture the
   frozen filesystem and publish its verified, retained durable root
   through the existing storage machinery. Upload completion alone is insufficient.
4. Recheck the staged memory checksums, then seal bounded artifacts against the exact filesystem archive and frozen
   inode/link identity, lease, OCI image, runtime/configuration, kernel and CPU
   compatibility identities. Verify all memory bytes before using them.
5. Resume only against the same private unchanged filesystem under the next lease
   generation. Preserve original command/output identities; old writers stay stale.
   Persist `resuming` before restore and observe uncertain effects without replay.

The initial native restore command disables background image loading. Deferred
loading can be considered later with independent page-integrity proofs, without
allowing unverified memory to execute. Live external connections are not promised
across suspension; callers must close and reconnect them explicitly.

## Recovery boundary

R2 remains the independent durable filesystem authority. A memory image is an
optional local acceleration artifact, not permission to release an uncertain
source or remove a retained durable checkpoint. Missing, incompatible or corrupt
memory must be refused. Cold recovery from R2 explicitly reports process-state
loss; it cannot claim that RAM, sockets or in-flight work survived.

The experimental SDK/server `suspend` operation now uses the existing durable
filesystem publication pipeline before acknowledging a sealed memory image. It
retains exclusive host ownership. Public managed memory resume and fallback are
still being implemented; ordinary `resume` retains its filesystem semantics.
Optional operator `workloadInit` uses the same unprivileged policy on Podman and
gVisor, allowing a stateful application to run while control I/O settles.

The Python bootstrap/control path now selects native lifecycle and exec adapters
from immutable host policy. The SDK exports the pinned `GVISOR_RUNTIME` policy for
explicit bootstrap composition. Unsupported Rust/egress combinations are rejected
before effects; ordinary bootstrap configuration still selects Podman.

Local tests exercise exec byte streams, cancellation/start identity, image-path
isolation and journal transitions using local processes or driver doubles. They
do not prove native gVisor operation or hosted performance. Managed memory resume/fallback
integration, real process-memory continuity, native interactive qualification,
matched timings and source-deleted R2 recovery remain separate gates.

## Operator and client usage

Select `runtime: GVISOR_RUNTIME` in the Boat bootstrap options, or the equivalent
pinned runtime policy in standalone `hostProvider` configuration. `workloadInit`
is an optional approved-image argv for the application init, identical on either
runtime. Unsupported egress and Rust-host combinations fail before installation.
The standalone service uses the same adapters and fencing as embedded clients.

Observe `sdk.runtimeCapabilities(sandboxId)` on an assigned sandbox. Memory
suspension requires `memorySuspendVersion: 1`. Call `sdk.suspend(sandboxId, id)`
and observe the stable operation until it completes. This publishes and verifies
the declared filesystem checkpoint, seals local memory, stops execution and retains
the exclusive source. It does not release that host into the idle pool.

Call `sdk.resumeMemory(sandboxId, id)` to resume. Successful operations explicitly
report `memoryPreserved`. A known unusable memory image or positively absent host
uses a retained, verified filesystem checkpoint and reports `memoryPreserved: false`
and a fallback reason after the replacement actually runs. Uncertain native effects
remain quarantined for reconciliation. Reconnect using the same operation ID;
never submit a second command to resolve an uncertain first command.

HTTP equivalents are `POST .../suspend`, `POST .../resume-memory` with an
`operationId`, and `GET .../capabilities`, under `/v1/sandboxes/{sandboxId}`.
The CLI exposes `suspend` and `resume-memory` with `--operation`. Ordinary `resume`
keeps its filesystem semantics. Memory artifacts are local and optional; durable
recovery depends on the configured checkpoint store, with R2 qualification pending.
