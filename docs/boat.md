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
workload. Automatic Boat bootstrap, transport discovery, and standalone CLI wiring
are still pending; this adapter alone does not make a newly created VM usable.

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
These transport paths currently have injected HTTP fixture coverage. Real execution
of the upload/verification/cleanup scripts, automatic runtime bootstrap, standalone
configuration and live-provider recovery still require qualification.

Wire schemas: [execute command](https://docs.boat.dev/api/reference/agent/execute-sandbox-command)
and [write file](https://docs.boat.dev/api/reference/agent/write-sandbox-file).
