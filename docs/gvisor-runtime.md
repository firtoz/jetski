# Use gVisor

Choose gVisor for its additional application-kernel boundary or compatible process
continuation. Podman remains the default. Read [runtime tradeoffs](runtime-comparison.md)
and qualify your actual workload before enabling it.

## Configure a compatible execution host

Import `GVISOR_RUNTIME` from `@firtoz/jetski/core` and set it as the provider's
`runtime` policy, with `networkMode: "none"` or the qualified `public-egress` profile.
The same pinned policy is accepted by embedded Node and standalone configuration.
Optional `workloadInit` is an approved-image argv for a long-running application.

The supported host path is Python/Linux x86-64 with systrap, explicit subordinate
user mappings and cgroup v2 delegation. Unsupported Rust/network combinations fail
admission. Bootstrap verifies the pinned runtime archive and actual namespace/
CPU/memory/PID limits. It installs on owned execution machines, not your controller
or desktop, and changes no global runtime default. Immutable runtime changes
require replacement hosts.

Plain upstream `runsc --rootless` is not this checkpoint-capable configuration.
On restricted AppArmor hosts, bootstrap needs the scoped policy-loader support;
it does not disable global namespace restrictions. Missing support refuses
bootstrap. [Host implementation contract](../maintainer/runtime.md).

## Suspend and resume

Observe `sandbox.runtimeCapabilities()` (or explicit SDK
`runtimeCapabilities(sandboxId)`) on the assigned host. Suspension requires
`memorySuspendVersion: 1`; portable publication additionally requires
`portableMemoryVersion: 1`.

- Ordinary `checkpoint()`/`stop()` preserve files and terminate processes, with
  a graceful shutdown interval before forced termination.
- `suspend()` stops execution and seals RAM against the exact filesystem/runtime
  identity. Without portable options the image remains local and retains its host.
- `resumeMemory()` requires proven process continuation. The explicit underlying
  outcome can report known filesystem fallback; the convenience method rejects
  that as memory recovery. Uncertain native effects remain quarantined.

Resolve commands, uploads and interactive streams before capture. Keep external
connections disconnected and reconnect them explicitly after restore. Preserve
operation identities and inspect their outcomes; a timeout does not authorize a
second native restore or replacement command.

CLI equivalents are `suspend ID --operation UUID` and
`resume-memory ID --operation UUID`. The HTTP routes are `/suspend`,
`/resume-memory` and `/capabilities` below `/v1/sandboxes/{id}`.
Ordinary `resume` retains filesystem semantics.

For recovery after physical source loss, publish explicit portable RAM/filesystem
objects. Local memory alone cannot survive that loss. Back up controller metadata
as well as objects, and preserve compatible runtime/image/helper ABI, kernel and
CPU requirements. [Portable setup](portable-memory.md) ·
[Qualification and limits](../maintainer/qualification.md).
