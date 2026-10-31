# Boat machine-host adapter

`jetski/providers/boat` exports `BoatApi` and `BoatHostProvider`. This adapter
provisions owned machines and implements the core allocation/inspection/retirement
contract. It uses the public HTTPS API with explicit credentials; it does not import
a provider SDK into the core or SDK entry points.

Allocation persists a random provider idempotency key and the complete request
before network dispatch. A replay uses the same body, including the originally
chosen machine type and TTL. Configuration changes do not change an admitted
request. The supported machine types are `small`, `default`, and `large`, with
`small` as the default. Lifetime is bounded to one hour. Snapshots and provider
monitoring are disabled, and no provider environment is inherited.

Creation retries stop when the requested lifetime expires. An expired unknown
allocation needs operator reconciliation; starting another operation is not a safe
substitute. The provider documents a 24-hour idempotency retention window, so the
adapter never intentionally retries beyond that window. A known completed
allocation retains its original host identity even after retirement.

Inspection checks provider state and the injected host transport's protocol status.
An API-ready VM is not admitted as ready until the installed host-control agent
reports the expected machine identity and readiness. The transport/bootstrap layer
must install and qualify the rootless runtime and keep its credentials outside the
workload. The standalone Boat configuration wires automatic bootstrap and this transport.
Direct embedded callers inject `BoatBootstrap` as the provider bootstrap hook.

Retirement only accepts an allocation found in this controller's persisted ownership
journal and the exact allocation ID. Deletion sends the provider's confirmation
header and observes resource absence before recording retirement. An accepted or
uncertain deletion remains pending and is reconciled under the same identity.
Unknown machines are never adopted or deleted implicitly.

The HTTP client rejects redirects, caps responses at 1 MiB, and applies a 30-second
deadline. Failed responses do not echo provider bodies. API credentials should be
scoped to the intended account and resource permissions; changing accounts requires
separate controller state.

## Evidence and limitations

Tests use an injected HTTP fixture plus real SQLite reopen. They cover committed
creation acknowledgement loss, frozen request replay, expiry, owner fencing,
readiness attestation, pending deletion and terminal replay. They do not establish
real Boat provisioning, rootless runtime support, fresh-host recovery, or costs.
No live allocation was made for this implementation. Hosted qualification requires
an explicitly approved experiment allowance.

Provider contracts were checked against the official
[API overview](https://docs.boat.dev/api/v1),
[creation reference](https://docs.boat.dev/api/reference/sandboxes/create-sandbox),
and [deletion lifecycle](https://docs.boat.dev/data-retention).

## Host-control transport

`jetski/transport/boat` exposes `BoatTransport(state, api)`. It accepts only hosts
in the allocation journal, invokes the fixed installed Python control program, and
requires an exact protocol/version/request-ID response. Provider command errors,
truncation, timeout, cancellation and response mismatch are uncertain outcomes;
the transport never retries workload effects automatically.

Requests up to 48 KiB use a base64-encoded pipe to the control program. Larger
requests (up to 1 MiB) use a newly created mode-0700 temporary directory and the
provider file API, avoiding Linux's per-argument size limit. Before dispatch the
host verifies the input length and SHA-256. Cleanup checks directory ownership,
mode, symlink refusal and exact expected contents; it never recursively deletes.
An uncertain cleanup reports failure so the caller must inspect before reuse.

Command responses allow an 8 MiB JSON envelope while enforcing the protocol's
2 MiB stdout and 64 KiB diagnostic bounds. Command deadlines are configurable from
1 to 600 seconds; the HTTP deadline also allows the provider's startup wait.
The host scripts have disposable Linux execution coverage. The corrected fixture
runs provider commands as a non-root guest, matching Boat, with `sudo -n` only for
the fixed privileged control program. Fresh bootstrap qualification is in CI;
live-provider recovery remains unqualified.

Wire schemas: [execute command](https://docs.boat.dev/api/reference/agent/execute-sandbox-command)
and [write file](https://docs.boat.dev/api/reference/agent/write-sandbox-file).


## Automatic owned-machine bootstrap

`jetski/providers/boat-bootstrap` exports the Node-only `BoatBootstrap`. The
standalone host factory selects it only for a Boat configuration:

```json
{
  "hostProvider": {
    "kind": "boat",
    "tokenEnv": "BOAT_API_TOKEN",
    "machine": "small"
  }
}
```

This replaces `hostProvider: { "kind": "ssh", "hosts": [...] }`; the other server
fields (pool ID, approved images, storage and principals) remain required. The
credential comes from that explicitly named controller environment variable.
Creating demand may allocate a billable VM. Do not enable it without an allowance.
`standaloneHosts` constructs adapters without allocating anything on its own.

Bootstrap uploads the package's ordinary Python source modules through the bounded
private file channel. The installer runs with passwordless sudo on the owned VM,
never on the controller. Missing Podman/uidmap/network/filesystem/user-session
prerequisites are installed from the host's configured apt repositories; unrelated
packages are not upgraded. The installation still checks supported architecture,
namespaces, cgroups, subordinate IDs, runtime and immutable image policy.

The controller journals the exact code, installer and policy digests before
installation. A root-owned host lock and fsynced receipt bind the installed code
and configuration. Retrying after an uncertain response checks the same receipt,
installed bytes and readiness. Conflicting policy/code, a foreign existing
configuration, unsafe paths, or an unreceipted active assignment fail closed.
Completed controller receipts avoid reinstalling on every readiness poll. A new
package revision requires explicit replacement, not an implicit upgrade of warm
assigned machines. Reconciliation exposes failure as unknown readiness and keeps
work queued. Diagnostics are bounded and provider credentials never enter bundles.

Boat documents its non-root guest and passwordless sudo in
[the machine reference](https://docs.boat.dev/machines). Earlier disposable tests
ran the command envelope as root and did not qualify that privilege boundary;
the corrected fixture explicitly rejects a root provider-command process.

## Interactive stream transport

`jetski/transport/boat-stream` supplies `BoatStreamTransport`, automatically selected
by the standalone Boat factory. It registers a per-machine Ed25519 public key with
the authenticated Boat API and pins the returned SSH host key in transactional
controller state. Private keys stay in that state, outside workloads and public
receipts; protect the state database as a credential store. Lost registration
responses reuse the same key. Changed host keys require explicit reconciliation.

Only unexpired, owned allocations matching the lease owner may connect. SSH runs
the fixed privileged host-control entry point as Boat's `user`; it does not expose
an outer-host shell through the sandbox API. Workload access still requires the
normal generation-fenced stream reservation. Connections have bounded admission,
framing and lifetime, and are never automatically replayed after interruption.
The adapter accepts Boat's IPv4 forwarding endpoint or direct IPv4/IPv6 address.
Provider registration currently runs per connection; live latency and provider
compatibility remain qualification gates.

Wire contract: [Boat's versioned OpenAPI](https://docs.boat.dev/openapi/boat-v1.yaml),
`POST /sandboxes/{sandboxId}/sshkey`.
