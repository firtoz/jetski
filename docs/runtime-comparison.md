# Choose Podman or gVisor

Use the default rootless Podman backend for broad Linux compatibility and durable
filesystem sessions. Choose gVisor explicitly when its additional application-kernel
boundary or qualified process-memory recovery is valuable and your workload passes
the required compatibility/resource checks. Benchmark your actual workload.

The machine provider supplies a host; the runtime controls execution inside it.
Podman is a container engine. gVisor's `runsc` implements a user-space kernel.
Jetski uses Podman tooling for images/network preparation, while its native gVisor
lifecycle adapter owns runsc process recovery. They are not alternative VM providers.

| Concern                  | Rootless Podman                                                            | gVisor                                                                   |
| ------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| System calls             | Host Linux through namespaces and restrictions                             | Linux interfaces implemented through Sentry                              |
| Isolation                | Mapped users, namespaces, cgroups and container policy; shares host kernel | Adds application-kernel boundary with the same host/resource policy      |
| Compatibility            | Broad host Linux behavior under container restrictions                     | Validate implemented interfaces against the actual workload              |
| Performance              | Avoids Sentry interception                                                 | Syscall, metadata, subprocess and network overhead is workload dependent |
| Filesystem checkpoints   | Verified files, modes and links                                            | Same durable publication/retention machinery                             |
| RAM continuity in Jetski | No implemented/qualified memory adapter                                    | Compatible same-host and opt-in portable RAM recovery                    |
| Host backend             | Python or optional Rust                                                    | Python, Linux x86-64, systrap; unsupported combinations refuse admission |

Neither is a whole VM or universal security guarantee. Keep resource/egress policy,
secret separation and patched hosts/runtimes. One assignment per host and no
cross-owner reuse apply to both. Podman supports CRIU upstream, but Jetski's
qualified memory path is gVisor; ordinary filesystem resume never claims RAM
continuation.

## Configure it deliberately

For fixed gVisor policy, use `runtime: GVISOR_RUNTIME` from `/core` in the provider
configuration. See [gVisor setup](gvisor-runtime.md). For required/preferred selection
with explicitly allowed fallback reasons, use [runtime selection](runtime-selection.md).
Unknown capabilities, bootstrap failures, corruption and uncertain commands never
authorize a weaker retry.

Same-host memory suspension retains exclusive compute. Portable memory also
stores verified RAM objects matching the filesystem root and requires compatible
runtime/image/helper ABI, kernel and CPU features. External sockets must reconnect.
[Memory setup and limits](portable-memory.md).

## What measurements tell you

A controlled 20-cycle Boat/R2 comparison used the same image/resources and graceful
shutdown policy. Host pairs disagreed on lifecycle speed; syscall-heavy gVisor
stages had substantial overhead. It establishes neither a consistent runtime
latency winner nor a multiplier for whole builds or browser sessions.
[Method and application-stage measurements](../maintainer/benchmarks/runtime.md).

Memory compression/reuse measurements compare equal filesystem-plus-RAM durability
boundaries; they are not Podman-versus-gVisor results. Runtime choice does not
change the provider's host price. Include retained compute and memory-storage/
request costs when deciding whether process continuity pays off.
[Memory measurements](../maintainer/benchmarks/memory.md) · [cost model](costs.md).

Upstream references: [Podman](https://docs.podman.io/en/latest/markdown/podman.1.html),
[gVisor security](https://gvisor.dev/docs/architecture_guide/security/),
[compatibility](https://gvisor.dev/docs/user_guide/compatibility/linux/amd64/),
[checkpoint/restore](https://gvisor.dev/docs/user_guide/checkpoint_restore/).
