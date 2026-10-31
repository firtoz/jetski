# Standalone service (implementation preview)

The current server implements creation, inspection/listing, operation receipts,
command admission/status and resumable output, checkpoint, stop, resume and deletion. Interactive gateways are not implemented yet. Do not
use this preview as a durable hosted service; use disposable qualification hosts.
The full release gates remain in [implementation.md](implementation.md).
Select `hostProvider: { "kind": "ssh", "hosts": [...] }` for an adopted host,
or the [Boat configuration](boat.md#automatic-owned-machine-bootstrap) for automatic
owned-machine bootstrap. The instructions below describe the SSH path.

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

Persistent-file inspection uses `GET /v1/sandboxes/{id}/files/read` and `files/list`.
The SDK exposes `readFile`, `readFileStream` and `listFiles`. Reads return bounded
256 KiB base64 chunks with digest, extent and version tokens. The streaming helper
verifies each digest and rejects a changed version or stalled cursor. Listings
return at most 256 entries per page and reject directories exceeding 10,000 entries.
Pass the prior version on subsequent pages to detect directory-entry changes.
These are observations of live files, not consistent snapshots of active workloads.
The API exposes only declared persistent paths, rejects symlink traversal and
special-file reads, and never resolves arbitrary host paths. Symlinks are listed
as metadata. Invalid UTF-8 names fail listing rather than being silently changed.
Uploads use `POST /v1/sandboxes/{id}/files/uploads`, `PUT .../{upload}` for chunks,
`GET .../{upload}` for observation and `POST .../{upload}/finish` for publication.
Specify an immutable UUID, persistent path, byte count, SHA-256 and optional mode.
The SDK's `writeFileStream` accepts an async byte source; retries use the same ID,
metadata and source from byte zero, skipping already acknowledged staging bytes.
Limits are 64 MiB per file, 256 KiB per chunk and 64 identities per host assignment.
Only finish publishes the destination; chunk acknowledgements cover private staging.
A committed file write is durable on the execution host, not a remote checkpoint.
Use checkpoint/stop to publish durable recovery storage before releasing the host.
Stop aborts incomplete uploads and resolves admitted finish intents before quiescence.
Unknown publication outcomes retain the source. Replays cannot overwrite newer edits.

CLI: `jetski files ID /workspace`, `jetski file-read ID /workspace/file` (binary
stdout), and `jetski file-write ID /workspace/file LOCAL_FILE --id UUID`. The writer
hashes the local source before streaming; a changed source fails full-file verification.
The initial file API replaces a directory entry atomically, rather than modifying
all hardlinks to its previous inode. Intermediate directories must already exist.


Checkpoint history is available at `GET /v1/sandboxes/{id}/checkpoints` and
`GET .../checkpoints/{checkpoint}`. Pages contain at most 100 filesystem summaries;
command-output objects and internal actor records are not exposed. Keyset pagination
is a live view: restart the scan to include concurrent insertions before the cursor.
Metadata inspection does not perform an object integrity audit.

`POST .../checkpoints/{checkpoint}/pins` accepts `operationId`, `pin` and `retain`.
Pin changes and their operation outcomes commit atomically. Replaying an old request
observes its prior outcome; it does not reverse later changes. Up to 128 named pins
can protect a checkpoint. Removing a pin does not retire the root or schedule its
collection; acknowledged history remains retained until explicit retirement.
SDK methods are `checkpoints`, `checkpoint` and `pinCheckpoint`. CLI equivalents:
`jetski checkpoints ID`, `jetski checkpoint-info ID CHECKPOINT`, and
`jetski checkpoint-pin ID CHECKPOINT NAME --operation OP_ID` (or `checkpoint-unpin`).
These metadata operations survive sandbox stop, resume and deletion. Public explicit
retirement remains pending.

`POST /v1/sandboxes/{id}/resume` accepts optional `checkpointId` alongside its
`operationId`. Omit it for the latest checkpoint; supply a retained filesystem root
to restore older bytes into a fresh writable sandbox. The sandbox must be stopped.
This does not delete newer history. SDK: `resume(id, operationId, checkpointId)`;
CLI: `jetski resume ID --operation UUID --checkpoint CHECKPOINT`.
The selected root has an internal lifecycle reference until placement succeeds or
queued placement is cancelled. User pin removal cannot remove this reference.
Uncertain restore preserves it. Replaying the same operation observes its original
selection; an explicitly different target conflicts. Invalid, retired or non-filesystem
roots are rejected before placement or generation advance.


Optional S3-compatible checkpoint storage is configured as described in
[storage contracts and qualification limits](storage.md). Local remains the default.

Command cancellation uses `POST /v1/sandboxes/{sandboxId}/commands/{commandId}/cancel`
with `{}`, SDK `cancelCommand`, or CLI `cancel SANDBOX COMMAND`. The command ID
identifies one durable cancellation intent; a controller restart reconciles pending
intents. A queued cancellation prevents execution. Running cancellation targets its
supervised exec session and requires authenticated evidence that descendants were
reaped. An unrelated command can continue; missing cleanup proof quarantines the
assignment and reports uncertainty. A naturally completed command retains its
original outcome. Host bootstrap requires a C compiler and static libc development
files to build the supervisor, and enables the private rootless Podman socket.

Terminal sessions use `POST /v1/sandboxes/{sandbox}/terminals` with the same
`id`, `argv`, `cwd`, `timeout` fields as commands. Their `output` endpoint exposes
merged PTY bytes through reconnectable cursors. `POST .../terminals/{id}/inputs`
takes `{id, input}`; input is stdin (`base64`, at most16KiB), resize (`rows`,
`columns`,1–4096), signal (`INT`, `QUIT`, `TSTP`) or close. Reuse the input ID to
observe its existing outcome; changed contents under that ID are rejected.
`GET .../inputs/{inputId}` observes the durable controller receipt. Sent means
accepted by the private attach transport, not consumed by the workload. Uncertain
sends are never automatically replayed. Shutdown retains outcomes before releasing
the host; proved absent inputs on a closed host settle as cancelled.

The SDK exposes startTerminal, terminalInput, terminalInputStatus, terminalStatus,
terminalOutput and closeTerminal. Thin CLI commands use the same terminal names;
terminal-input reads bounded JSON from stdin with `--id` for replay identity.
Initial rows/columns default to 24/80 (each 1–4096); they are applied before the
workload starts and bound to terminal identity. CLI terminal-start accepts
--rows and --columns. Full interactive attach, worker-loss qualification and gateways
remain under development. These endpoints are experimental; releaseQualified and
PTY qualification remain false until the remaining terminal checks pass.


Host workers hold private lifetime locks before publishing running receipts.
A later host request observes a lost worker as an uncertain command and quarantines
the assignment; it never restarts the workload or claims successful completion.
Launches carry the exact lease, so delayed workers cannot execute a reused command
ID in a newer assignment. Quarantine blocks new writes and execution but is not a
claim that existing workload processes have stopped: explicit quiescence still
stops the container. Uncertain commands continue to block successful host release,
and the source is retained. Detection currently requires a host control request;
autonomous host monitoring and resolution of quarantined execution remain open.


The SDK followTerminal async iterator observes output with pull backpressure and
validated binary byte cursors. Save each nextOffset after consuming its bytes;
resume with that offset to avoid replaying already consumed output. An AbortSignal
detaches observation without closing the remote terminal. Read failures surface
to the caller; the SDK does not restart commands or resend input. Idle observation
polls every250ms; this is HTTP cursor polling, not a WebSocket stream.
CLI terminal-follow SANDBOX TERMINAL --offset BYTES writes binary stdout and waits
for local output drain. It does not persist a cursor automatically. Interactive
stdin attachment and public gateways remain separate unfinished features.

For durable interactive input, use
client.attachTerminal(state, attachmentId, sandboxId, terminalId) with an injected
transactional StateStore (SQLite is available for Node clients). The SDK persists
one pending input before admission. Call resume() after reopening the same state;
it first observes the input identity and only admits it if the API confirms absence.
Lost acknowledgements never cause a new input identity. send(input, signal) accepts
bounded stdin, resize, signal and close frames and waits for their delivery outcome.
Serialize sends; a pending input rejects additional admission. Uncertain/cancelled
outcomes throw TerminalDeliveryError and block that attachment from continuing.
A sent receipt means transport acceptance, not workload consumption or completion.

The local journal is bound to server origin, credential fingerprint and terminal;
raw credentials are not stored. Credential rotation requires deliberate recovery,
not automatic rebinding. Protect the client state directory: pending input may
contain private text. Server history remains authoritative; the client keeps only
its latest input and explicit output cursor. cursor()/acknowledgeOutput(from,to)
support compare-and-set cursor persistence after consumption. Display and local
cursor writes are not atomic, so a client crash between them may repeat displayed
output. Raw-TTY CLI attachment and gateways remain unfinished.
