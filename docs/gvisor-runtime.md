# Optional gVisor runtime

This is active implementation work, not a qualified or selectable runtime yet.
Podman remains the supported default. The [goal](goals/gvisor-runtime.md) tracks
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
3. Capture the frozen filesystem and publish its verified, retained durable root
   through the existing storage machinery. Upload completion alone is insufficient.
4. Seal bounded memory artifacts against the exact filesystem archive and frozen
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

The new integrity/lifecycle tests use local files and a driver double. They prove
bounded checks and journal transitions, not native gVisor operation or hosted
performance. Native execution/transport integration, actual memory continuity,
matched timings and source-deleted R2 recovery are separate remaining gates.
