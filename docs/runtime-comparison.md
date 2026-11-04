# Choosing the Podman or gVisor backend

Refreshed November 4, 2026 with a [new fairer comparison](runtime-fair-benchmarks.md):
twenty Boat/R2 cycles, twenty local application samples and both private-browser
demos. Podman remains the deployment default; [explicit preference and fallback](runtime-selection.md)
is opt-in. The older lifecycle results below are historical and retain their
shutdown-policy confound. Use the newer report for current matched measurements.

## Where each component fits

The machine provider supplies a Linux host. Jetski controls owner-exclusive
placement, operations, files, checkpoints and recovery. Its runtime adapter
controls workload execution inside that host. R2 or another qualified store keeps
immutable checkpoint objects; transactional state retains authoritative roots,
leases and outcomes. Changing runtime does not replace these other components.

Podman is a container engine; gVisor's `runsc` is an OCI runtime implementing a
user-space kernel, called Sentry. They can be combined upstream. Jetski currently
selects separate Podman and native-runsc lifecycle adapters; it does not stack
Podman's execution journal around a separately restored runsc process.
[Podman overview](https://docs.podman.io/en/latest/markdown/podman.1.html),
[gVisor overview](https://gvisor.dev/docs/).

## Capability and isolation tradeoffs

| Area                          | Default rootless Podman backend                                                         | Optional gVisor backend                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| System calls                  | Uses host Linux through container namespaces and configured restrictions                | Implements the Linux interface in Sentry; reduces direct host-kernel exposure                                      |
| Isolation                     | Unprivileged mapped users, namespaces, cgroups and container policy; shares host kernel | Additional application-kernel boundary, plus Jetski's namespaces, mapped users and enforced limits                 |
| Workload compatibility        | Host Linux behavior, subject to configured container restrictions                       | Must fit the implemented syscall/interface surface; validate actual workloads                                      |
| CPU and memory access         | Native execution                                                                        | Application instructions and ordinary mapped memory access remain native; interception and runtime state add costs |
| Filesystem/network-heavy work | Avoids Sentry interception                                                              | May incur additional processing/latency; depends on workload and platform                                          |
| Filesystem durability         | Verified local/S3/R2 checkpoints                                                        | Same publication, reader/writer, retention and GC machinery                                                        |
| RAM continuity in Jetski      | No implemented memory adapter                                                           | Same-host suspend/resume and opt-in portable RAM checkpoints                                                       |
| Qualified host implementation | Python or optional Rust                                                                 | Python, Linux x86-64, systrap; unsupported combinations refuse admission                                           |

The isolation advantage is a reason to choose gVisor for untrusted code. It does
not remove the need for resource/egress policy, secret separation or a patched
host/runtime. Neither backend is a universal security guarantee or an entire VM.
Jetski keeps one active assignment per host and forbids cross-owner host reuse
with either choice; this comparison assumes no concurrent multi-tenant packing.
See the upstream [security model](https://gvisor.dev/docs/architecture_guide/security/)
and [compatibility reference](https://gvisor.dev/docs/user_guide/compatibility/linux/amd64/).

Upstream gVisor describes structural syscall/memory overhead and workload-dependent
filesystem/network costs. Its published performance guide contains older ptrace
measurements: do not apply those ratios to Jetski's systrap implementation. Our
lifecycle tests also do not measure compiler, database or sustained HTTP throughput.
[Performance guide](https://gvisor.dev/docs/architecture_guide/performance/).

## What the measured speed difference means

The [November 3 comparison](gvisor-benchmarks.md) used the same pinned image,
one CPU / 512 MiB limit, two hosts per mode and reversed mode order. Ten samples
per mode preserved files and acknowledged output.

| Median stage                    | Podman filesystem | gVisor filesystem | gVisor same-host RAM |
| ------------------------------- | ----------------: | ----------------: | -------------------: |
| Resume to useful response       |             5.74s |             4.54s |                4.27s |
| Warm-controller response subset |             4.62s |             4.54s |                4.16s |
| Durable save                    |            19.28s |             7.92s |                6.84s |
| Quiesce or freeze               |            11.26s |             0.48s |                1.66s |
| Transfer/publication            |             2.58s |             3.15s |                2.18s |

Podman's PID 1 ignored SIGTERM and consumed its ten-second graceful-stop allowance;
gVisor filesystem stop killed processes and RAM suspend froze them. The save
policies are different, so the end-to-end gap cannot establish runtime superiority.
Do not remove an application's flush opportunity merely to improve a benchmark.
Use a working SIGTERM handler and explicitly agreed shutdown semantics in any
future fair stop-policy comparison. Timings above preserve the original behavior.

Cold setup included provisioning, runtime/image preparation and fixture setup:
80–97s for Podman, 209–311s for gVisor filesystem and 99s for the untainted memory
arm. These small, noisy samples are not isolated runtime-start costs. Sampled
current-generation cgroup memory medians were 64.54 / 74.03 / 75.23 MiB; ancestor
cache accounting prevents treating them as complete runtime footprint estimates.
Both filesystem-only replacement tests passed. Their R2 archives did not contain
RAM; the newer portable feature was qualified separately.

## Memory recovery and costs

Podman supports CRIU process checkpoint/restore upstream; it is inaccurate to say
Podman cannot save processes. Jetski's default rootless adapter does not implement
or qualify that path. Its current qualified RAM implementation is gVisor.
[Podman checkpoint documentation](https://docs.podman.io/en/latest/markdown/podman-container-checkpoint.1.html).

Simple `runsc --rootless` does not support checkpoint/restore. Jetski uses
caller-configured subordinate user mappings, network namespaces and delegated
cgroups, with explicit capability/resource checks. This bootstrap is more involved
than enabling a runtime flag. [Upstream rootless modes](https://gvisor.dev/docs/user_guide/rootless/).

Same-host RAM restore avoids restarting the application but retains exclusive
compute. Portable checkpoints additionally publish verified RAM chunks with the
exact filesystem root. Both objects and transactional metadata must survive.
Compatible runtime, image, helper ABI, kernel and CPU features remain necessary;
live external network sessions are outside the promise.
[Native checkpoint/restore](https://gvisor.dev/docs/user_guide/checkpoint_restore/),
[Jetski portable-memory contract](portable-memory.md).

The [November 4 memory comparison](portable-memory-benchmarks.md) found low-change
save medians of 65.76s raw full, 42.71s gzip full and 12.05s gzip incremental.
Entirely rewritten entropy stayed near 62–64s across modes. These are equal
filesystem-plus-RAM durability comparisons, not Podman-versus-gVisor results.
Two physically source-deleted RAM recoveries passed; one required a guarded bug
repair and the other passed automatically. Preserved failures and compatibility
limits remain part of the report.

Neither runtime changes the provider's host price. gVisor can add memory/CPU and
RAM-storage costs; process continuity may avoid expensive application warmup.
Both already benefit from Jetski pooling, so the runtime test does not demonstrate
fewer VM starts from gVisor. Price retained compute, requests, memory change rate
and checkpoints rather than assuming every suspension saves money.

## Why the default remains Podman

The default targets general Linux shell/file workloads with durable filesystem
recovery and broad compatibility. gVisor adds a valuable security boundary and
qualified process recovery, with a narrower supported host/runtime matrix and
additional compatibility and resource costs. The current fixture is insufficient
to justify switching every workload, and its save timings have a shutdown confound.

For untrusted workloads or costly process warmup, selecting gVisor explicitly is
reasonable after checking application behavior. For ordinary filesystem sessions,
Podman remains the simpler baseline. Defaults can change after representative
application and shutdown-policy evidence, rather than one favorable latency table.
