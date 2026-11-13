# Run on Boat

Boat supplies the physical machines; Jetski supplies owner-scoped sandboxes,
commands, verified checkpoints and host reuse. Start with the
[embedded hello-world example](../examples/02-hello-world-boat/).

## Choose configuration

Embedded Node accepts `provider: { kind: "boat", token }`. Supported machine types
are `small` (default), `default` and `large`. The provider block also accepts fixed
runtime/network/storage/init policy and opt-in verified binary archive reads.
Keep the API token private and the workload image digest approved.

The standalone equivalent is:

```json
{
  "hostProvider": {
    "kind": "boat",
    "tokenEnv": "BOAT_API_TOKEN",
    "machine": "small"
  }
}
```

The complete server configuration still needs a pool ID, approved images,
principals and data directory. [Standalone setup](standalone.md).
Demand can allocate billable hosts; opening an empty controller does not prewarm
them. Bootstrap installs missing prerequisites on owned execution machines, not
on your desktop. A provider-ready VM must pass host/runtime identity attestation
before workload placement.

## Reuse and retire

Default leases are one hour with ten-minute idle retention and zero minimum warm
capacity. Explicit lifecycle policy supports longer bounded leases up to the
provider's declared 24-hour maximum. Keep a controller alive to reuse released
hosts; `runSandbox()` closes it after one command. Adaptive idle pricing is an
optional decision aid, not an account spending guarantee. [Cost model](costs.md).

Allocation journals freeze the provider idempotency key, machine request and TTL
before dispatch. A lost acknowledgement is observed under the same identity;
configuration changes cannot alter admitted input. Replay ends at expiry or
23 hours after admission, whichever is earlier. Unknown expired allocations
require reconciliation, not replacement IDs.

Only positively owned allocations can retire. Deletion must be followed by
observed provider absence; an accepted/uncertain response remains pending. No
foreign machine is adopted or deleted implicitly. Saves must publish and verify
before assignment release; uncertain sources stay retained.

## Platform integration

Use [generic Boat composition](embedded-platforms.md#reusable-composition) to inject
state, assets, streams, pricing and runtime policy. Dedicated full-VM callers can
use the [host-only seam](embedded-platforms.md#dedicated-machine-lifecycle) without
claiming a sandbox runtime is ready. See [release availability](compatibility.md).

Advanced exports include `/providers/boat`, `/transport/boat`,
`/providers/boat-bootstrap`, `/providers/boat-bootstrap-embedded` and
`/transport/boat-stream`. Embedded streams require a qualified Node-compatible
SSH transport; credentials stay outside workloads and host keys are pinned.
Operator machinery and the [host protocol](../maintainer/runtime.md) remain separate
from the shared application API.

The API wrapper uses explicit credentials, HTTPS, bounded responses and deadlines,
without redirect or automatic workload retries. A transport timeout never confirms
cancellation. Changing accounts requires a separate bound controller namespace.

[Provider capabilities](embedded-platforms.md#capabilities) ·
[Networking](networking.md) · [Recovery](failure-recovery.md) ·
[Scoped provider evidence](../maintainer/benchmarks/providers.md).
