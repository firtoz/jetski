# Explicit runtime preference and fallback

`podman-only` remains the default deployment policy. The optional selection
components allow an embedding to prefer gVisor for new hosts when trusted
admission checks prove it meets the workload's requirements. They do not change
existing hosts, the standalone configuration default or a running workload.

## The three policies

- `podman-only`: require supported Podman capabilities.
- `gvisor-required`: refuse admission if gVisor cannot meet requirements.
- `gvisor-preferred`: choose supported gVisor, otherwise consider Podman only for
  the exact unsupported-capability reasons the operator explicitly permits.

`selectRuntime` and `bindRuntimeSelection` are exported from `jetski/core`.
`SelectingRuntimeBootstrap` is exported from `jetski/providers/runtime-selection`.
The latter composes an admission probe with existing runtime-specific bootstraps.
It persists the choice before bootstrap effects. Bootstrap failures propagate;
there is no catch-and-retry-on-Podman path.

```ts
const bootstrap = new SelectingRuntimeBootstrap(
  state,
  {
    mode: "gvisor-preferred",
    allowPodmanFallbackFor: ["host-platform", "host-backend", "network-policy"],
  },
  { networkMode: "none", portableMemory: false },
  admitHost, // Operator adapter: checked facts for both runtimes, with evidence IDs.
  (runtime) =>
    new BoatBootstrap(state, api, poolId, images, "none", "default", runtime),
);
```

This is embedding composition, not automatic host discovery. `admitHost` must
supply bounded, trusted capability evidence. A runtime binary existing or a
container launching is insufficient: check namespaces, effective resource limits,
image/workload compatibility and the requested network policy. Unknown support
blocks gVisor-preferred admission instead of silently downgrading isolation.
The bootstrap must still perform its own native integrity and policy checks.

Bindings use stable physical-host IDs in transactional state. The same policy
returns the bound decision after restart, even if a later observation changes;
it never changes the runtime of an existing host. A bound runtime becoming
unsupported or uncertain refuses admission; it never switches to the alternative. A changed policy requires
explicit host replacement. Keep bindings alongside other control-plane metadata.

## Fallback boundaries

An allowed reason is a known unsupported prerequisite, such as an unqualified
platform or network capability. Authentication failures, corrupt objects, lost
acknowledgements, arbitrary command errors and uncertain native effects are not
fallback reasons. Never rerun an uncertain command on another backend.

Required capabilities apply to the fallback too. If portable process memory is
required, today's Podman adapter cannot satisfy it; fallback must refuse. An
ordinary filesystem restore also cannot claim it preserved RAM. Cross-runtime
filesystem migration requires an explicit stopped, verified checkpoint and a new
placement; the selector does not implement or authorize that migration.

The qualified baseline gVisor profile is Python host / Linux x86-64 / systrap /
network `none`. The experimental [public-egress profile](networking.md) adds a
shared filtered IPv4 path for both runtimes; hosted qualification is in progress.
An admission adapter must supply evidence for that exact profile. It must never
treat support for legacy Podman `egress` as support for `public-egress`.

## Laptop and computer-use boundary

A sandbox can run its own Chromium and private Xvfb display without connecting to
the operator's real desktop. The local demonstration uses Podman as the engine
for both crun and runsc; it does not install Jetski's SSH host service on the laptop. [The executable demo](../examples/browser-desktop.mjs)
checks mouse input, typed text and a PNG screenshot against a trusted local page.
It requires an independently isolated container and explicitly selected
`--outer-sandbox-only`: Chromium's nested sandbox is disabled for this fixture.
This is not qualification for arbitrary untrusted browsing.

Do not mount the host's Wayland/X11 sockets, browser profile, credential stores,
clipboard, Docker socket or input devices to turn this into desktop access.
Keep control connections authenticated and separately scoped. Local hosting can
avoid provider starts, but consumes laptop CPU/RAM/disk/energy and depends on the
laptop remaining available. It does not replace remote durable storage or backups.

## Choosing an operating policy

| Workload                                                     | Suggested policy                                     | Tradeoff                                                              |
| ------------------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------- |
| Untrusted code requiring the application-kernel boundary     | `gvisor-required`                                    | Refuses incompatible hosts/workloads; no security downgrade           |
| Known compatible offline workloads, with approved exceptions | `gvisor-preferred`                                   | Better coverage, but callers must observe which runtime was selected  |
| Trusted builds with many subprocesses or metadata calls      | Benchmark first; Podman-only remains reasonable      | Native syscall compatibility may outweigh process-continuity benefits |
| Outbound-internet workloads on today's adapters              | Podman-only or an explicit `network-policy` fallback | Current gVisor adapter does not qualify egress                        |
| Portable RAM required                                        | gVisor capability required                           | Filesystem-only recovery is not an equivalent substitute              |

Admission facts and fallback permissions belong to trusted operator policy, not
workload-controlled request fields. A malicious workload must not be able to
trigger a weaker backend by deliberately failing a command or preflight. Emit the
selected runtime and fallback reason to your existing observability sink; a
heterogeneous fleet should not conceal its different isolation guarantees.
