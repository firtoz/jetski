# Standalone service (implementation preview)

The current server implements creation, inspection/listing, operation receipts,
command admission/status and resumable output, checkpoint, stop, resume and deletion. Interactive gateways are not implemented yet. Do not
use this preview as a durable hosted service; use disposable qualification hosts.
The full release gates remain in [implementation.md](implementation.md).

Install Node from `.nvmrc`, then `npm ci && npm run build`. Prepare a dedicated
Linux x86-64 host with rootless Podman prerequisites. As an operator on that host,
run `python3 host/bootstrap.py --config /path/to/host.json`; its configuration has
`version: 1`, `machineId`, `poolId`, and an explicit `images` digest allowlist.
The machine ID must match the SSH host ID and pool ID must match the server.
Bootstrap refuses an existing assignment or unsafe writable installation parents.
It does not install OS packages or modify an operator's desktop automatically.

Use a dedicated SSH key with a forced command:
`env -i PATH=/usr/bin:/bin python3 -I /opt/jetski/host/control.py`.
Disable port/agent/X11 forwarding on this administrative key and explicitly pin
the host key in the configured known-hosts file. This key is private control-plane
access; it is not the planned user SSH gateway.

Adapt [the example configuration](../examples/server.json) to that host. Supply a
random bearer token of at least 32 characters through `JETSKI_API_TOKEN`; no token
belongs in the configuration or repository. Run:

```
node dist/cli.js serve --config /path/to/server.json
```

The server binds loopback. Remote access requires an authenticated encrypted tunnel
or an operator-managed HTTPS reverse proxy. Checkpoint objects and SQLite state
live on the control-plane disk, independently of the execution host.

The thin CLI uses `JETSKI_TOKEN` and optionally `JETSKI_URL`. Creation and execution
require explicit UUIDs so retrying a request preserves its identity:

```
node dist/cli.js create --id SANDBOX_UUID --operation OPERATION_UUID --image IMAGE_DIGEST
node dist/cli.js get SANDBOX_UUID
node dist/cli.js exec SANDBOX_UUID --id COMMAND_UUID -- /bin/sh -c 'printf hello'
```

A server worker progresses queued work without an open browser. Its durable pool
ledger reserves one host per owner by default and queues excess assignments.
Unknown host effects quarantine the assignment; automatic recovery of every
interrupted lifecycle stage is still being implemented. Do not retry uncertain
commands with a new command ID.

`checkpoint ID --operation UUID` stops execution, retains terminal command output
and publishes the persistent filesystem while retaining the host assignment.
`stop ID --operation UUID` additionally removes the container, verifies publication
before release, purges its source tree and returns the host to its owner's pool.
Poll `operation ID --id UUID` for completion. Failed publication quarantines the
source; it never reports successful release. A lost release acknowledgement can
be reconciled using the existing receipt without creating a new assignment.

`resume ID --operation UUID` restores a stopped sandbox into a fresh writable
assignment. If its checkpoint still holds the host, the same durable resume request
first releases that assignment. Checkpoints and prior command output remain
retained across generations. Repeating the resume ID observes its existing work.

The worker retires released idle host allocations after ten minutes, or when their
allocation lifetime expires. It does not replenish idle hosts without queued demand.
SSH retirement releases the adoption record and leaves the operator's machine
running; permanent owner binding and generation continuity survive re-adoption.
Lost retirement acknowledgements retain the slot for reconciliation. Active assignments enter the durable stop sequence five minutes before allocation
expiry; hosts within that window receive no new assignments. Successful publication
and cleanup permit retirement. A deadline never authorizes discarding an uncertain
save. The five-minute allowance is not a guarantee against provider outages or
forced termination; actual cloud-provider deadline qualification remains open.

`delete ID --operation UUID` permanently prevents new execution/resume for that
sandbox identity. Assigned running/stopped sandboxes first complete verified save
and release; already released sandboxes record deletion atomically. Acknowledged
checkpoints and command history remain retained and readable; deleting a sandbox
does not authorize garbage collection of its history. Queued deletion atomically
cancels its placement without executing it. Undispatched allocation reservations
are discarded; already dispatched allocations are reconciled under their original
identity and any resulting idle host is retired normally. Starting and quarantined
placements must currently resolve before deletion is accepted.
