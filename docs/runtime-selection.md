# Select isolation without silent fallback

Runtime selection is trusted operator policy. It applies to new hosts and remains
immutable for each host; workload-controlled input cannot choose or weaken it.
Podman remains the default.

| Policy             | Admission behavior                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `podman-only`      | Require supported Podman capabilities.                                                          |
| `gvisor-required`  | Refuse if gVisor cannot meet the workload requirements.                                         |
| `gvisor-preferred` | Prefer supported gVisor; consider Podman only for explicitly permitted known incompatibilities. |

## Configure a selection policy

The [Boat composition factory](embedded-platforms.md#reusable-composition) accepts:

```ts
runtimeSelection: {
  preference: {
    mode: "gvisor-preferred",
    allowPodmanFallbackFor: ["workload-compatibility"],
  },
  workload: "qualified",
  portableMemory: false,
}
```

This factory is included in version 0.3.0; see [compatibility](compatibility.md). The operator
must independently qualify the exact image/runtime/network combination before
using `qualified`. An intentional gVisor exclusion uses `excluded`; missing or
failed qualification is unknown, not exclusion. Fixed `runtime` and selection
policy cannot be supplied together. Require `portableMemory: true` when process
continuity is essential; Podman cannot satisfy that requirement through fallback.

The factory checks fresh-host prerequisites, freezes a candidate before bootstrap,
and exposes a verified decision only after native isolation, resource and pinned
policy checks succeed. `hosts.runtimeDecision(host)` returns the runtime and any
authorized fallback reason, or null before verification. Inspect assigned runtime
support through `sandbox.runtimeCapabilities()`.

## Preserve the boundary

Allowed fallback reasons describe evidenced unsupported prerequisites. Authentication,
network failures, invalid probes, corrupt objects, arbitrary workload failures and
lost acknowledgements are not fallback reasons. Never rerun an uncertain command
on another backend. Required capabilities apply to the fallback too.

Bindings survive restart and belong with controller metadata. If an existing
runtime becomes unsupported or uncertain, refuse admission rather than rebinding
it. Changing policy requires explicit host replacement. Filesystem migration must
use a stopped verified checkpoint and new placement; selection does not authorize
that migration or claim RAM continuity.

The gVisor Python-host profile supports isolated networking and qualified
`public-egress`; legacy Podman `egress` is not equivalent. Admission evidence must
match the requested profile. [Networking](networking.md).

## Custom platform adapters

`selectRuntime`/`bindRuntimeSelection` from `/core` operate on trusted admission
facts for both runtimes. `SelectingRuntimeBootstrap` accepts fully verified
admission evidence. `PreparingRuntimeBootstrap` accepts prerequisite eligibility,
binds the candidate before effects and publishes the verified selection only after
bootstrap. `BoatRuntimeEligibility` performs bounded owned-host prerequisite
inspection; it is not proof of a running workload's compatibility.

Use these advanced adapters only when the composition factory does not fit. Binary
presence or a container launching does not prove namespaces, enforced resource
limits, image compatibility or network policy. Keep selection and fallback reasons
visible to application observability without exposing credentials.

A private Chromium/Xvfb demo is separate from real desktop access or qualification
for untrusted browsing. Do not mount desktop sockets, profiles, credential stores,
clipboard, runtime sockets or input devices as a side effect of a demo.

[Runtime tradeoffs](runtime-comparison.md) ·
[Scoped selection evidence](../maintainer/qualification.md#runtime-selection).
