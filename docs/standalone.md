# Standalone service (implementation preview)

The current server implements creation, inspection/listing, operation receipts,
command admission/status and resumable output, checkpoint, stop, resume and deletion.
Experimental SSH terminal, TCP and HTTP/WebSocket preview transports are described
below; browser preview sessions remain under development. Do not
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

When a source has disappeared during an unfinished save, an operator can explicitly
select an older retained filesystem checkpoint with `recover-missing-source ID
--operation UUID --config recovery.json`. The JSON contains `generation`, the exact
`lease` from sandbox inspection, `shutdownId`, `checkpointId`, and
`acknowledgement: "unpublished-changes-unavailable"`. The SDK exposes the same
operation. `pending-operations ID` lists pending/uncertain operations, including
lifetime-triggered saves; follow the returned cursor with the SDK when needed.
Recovery requires positive provider absence and refuses other active
storage actors, stale authority or invalid retained objects. It leaves the sandbox
stopped at the selected checkpoint; use a separate resume operation afterwards.
The incomplete save stays uncertain and recorded. Unpublished changes are not
recovered, and uncertain commands must not be replayed automatically. This path
has local fault/restart coverage; hosted qualification remains pending.

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
--rows and --columns. Broader host-restart qualification and public gateways
remain under development. These endpoints are experimental: pty reports implemented
API support, while releaseQualified stays false until the full release gates pass.


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
stdin attachment uses the durable journal described below; the experimental SSH
gateway is described in its own section.

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
output. The raw-TTY CLI adapter and experimental SSH gateway are described below.

CLI terminal-attach SANDBOX TERMINAL --id ATTACHMENT --state-dir PRIVATE_DIRECTORY
opens an existing terminal using a private, owned SQLite client journal. Reuse the
same attachment ID and directory to recover pending input and the output cursor.
On a local TTY it forwards raw input (including Ctrl-C), sends initial/latest window
sizes and restores the original terminal mode on normal exit, detach or errors.
Ctrl-] detaches; SIGINT/SIGTERM/SIGHUP also detach without stopping remote execution.
Only journaled input is resumed: detaching discards local keystrokes that have not
yet become an input operation. Stdin EOF also detaches; use terminal-close for
explicit remote termination. Piped input treats every byte literally.

The CLI queues at most64KiB of unsubmitted input and submits frames of at most16KiB
serially. Resize events coalesce. Each input observation/delivery has a30second
client deadline; timeout preserves its journal identity for explicit reconnect.
The output side follows consumer demand. Local display and cursor persistence are
not atomic; interrupted display can repeat bytes on reconnect. API gates and real
PTY qualification are tracked in the implementation document.

## SSH terminal gateway (experimental)

The optional `jetski/server/ssh` export provides an encrypted, public-key-only
attachment gateway. It is not loaded by SDK/core imports. `serve` enables it only
when `sshGateway` is configured:

```json
{
  "sshGateway": {
    "hostKeyPath": "/private/gateway-host-key",
    "host": "127.0.0.1",
    "port": 2222,
    "maxConnections": 64,
    "principals": [{ "owner": "alice", "publicKey": "ssh-ed25519 PUBLIC_KEY" }]
  }
}
```

Protect the host private key with operator-only permissions and pin its public key
in clients' known-hosts files. Keys map to owners; the SSH username selects a
sandbox. First create a terminal through the API/SDK, then attach with an explicit
terminal identity and output byte offset:

```sh
ssh -p 2222 -t SANDBOX_ID@localhost 'attach TERMINAL_ID 0'
```

The command has a strict grammar and is never interpreted by a host shell.
Password auth, outer shells, arbitrary commands, SFTP, environment changes,
agent/X11 forwarding and arbitrary host TCP forwarding are rejected. The gateway
attaches to existing PTY terminals; it does not create terminals on reconnect.
Authorized workload TCP connections use the explicit forwarding protocol below.

Input uses the core's durable receipt IDs, one serialized frame at a time, up to
16 KiB per frame. Queued control requests are bounded to 64; receipt observation
has a 30-second deadline. Failed/uncertain delivery closes the connection rather
than resending bytes. SSH transport acknowledgement is not proof that the workload
consumed input. Reconnecting SSH clients must not automatically replay typed input.
Output resumes at the explicitly supplied byte offset; ordinary SSH clients do not
persist a verified display cursor. Use the durable SDK/CLI attachment for that.

PTY geometry and supported INT/QUIT/TSTP signals use the same core lease checks.
Disconnect or input EOF detaches without closing the remote terminal. Connections
allow one session, have a 15-second admission deadline and a one-hour attachment
limit. Server shutdown waits for active attachment tasks. These bounds do not
replace an operator's network ingress policy. Container-backed qualification and
all broader release gates are tracked in the implementation checklist.

## Port permissions (transport work in progress)

`exposePort(sandbox, operationId, port)` records permission for a workload TCP port
and returns a durable operation receipt. The operation ID is also the exposure ID.
`portStatus` inspects it; `revokePort` takes a separate stable operation ID. The
corresponding HTTP routes are documented in `openapi.json`. No arbitrary destination
hostname or address is accepted. SDK calls do not open a network connection yet.

Permissions are owner-scoped and bound to the current running assignment, image
and generation. Stopping, replacing or advancing the assignment makes them
unavailable. Resume requires new permissions; replaying an old grant only returns
its original outcome. Revocation is permanent for that exposure ID, survives
controller restart and does not erase history. At most 64 permissions may be
available per sandbox. The experimental SSH gateway uses these permissions and
the core stream coordinator for active-stream revocation and generation fencing.
Full gateway lifecycle/replacement qualification and HTTP/WebSocket previews remain
open release gates.

## SSH workload TCP forwarding (experimental)

When an SSH host stream adapter is configured, the public-key gateway accepts
`direct-tcpip` channels addressed to `EXPOSURE_ID.STREAM_UUID.jetski`, with the
exact port recorded by `exposePort`. This is a protocol address, never a DNS name
or an outer-host destination. The SSH username selects the sandbox and the key
selects the owner. For example, after creating a port exposure for8080:

```sh
ssh -p 2222 -W EXPOSURE_ID.STREAM_UUID.jetski:8080 SANDBOX_ID@localhost
```

Supply a fresh canonical UUID for each intentional new connection. Reusing it is
rejected even after disconnection; neither the gateway nor host automatically
reconnects or replays bytes. Use the operation/stream receipt to investigate
uncertain completion. A channel closing is not proof that its durable operation
succeeded. The CLI prints each stream ID to stderr before SSH admission.

For a loopback listener, use `jetski forward SANDBOX_ID EXPOSURE_ID --config PATH`:

```json
{
  "host": "gateway.example.com",
  "port": 2222,
  "privateKeyPath": "/private/client-key",
  "hostPublicKeyPath": "/private/pinned-gateway-key.pub",
  "remotePort": 8080,
  "localPort": 8080
}
```

Obtain the gateway public key from its operator over a trusted channel. The client
requires that exact key; it does not learn keys on first contact or use an SSH
agent. Authentication completes before binding127.0.0.1. Omit localPort for an
OS-assigned port; the listener address is printed to stderr. At most eight local
connections run at once. Each intentional local connection gets a new UUID;
transport failure stops the listener and rejects its completion promise, without
reconnecting or replaying data. SIGINT/SIGTERM closes the listener and active
channels. Socket pipes provide backpressure and preserve both half-closes.
The optional Node API is `jetski/client/forward`; SDK/core imports do not load it.
Its onStream callback runs before dispatch and may record the stream identity;
throwing prevents that connection from opening. Network closure still requires
operation inspection if the application needs verified delivery/cleanup.

The gateway caps forwarding at64channels total and8per authenticated connection.
It does not mix terminal sessions and forwarding channels on one SSH connection.
Input follows the SSH receive window (at most2MiB chunks), split into awaited16KiB
host writes. Output writes have a5second backpressure deadline; admission is
bounded to30seconds and connections to1hour. Both TCP half-closes are supported:
output EOF does not prevent further input. After both directions drain, an orderly
SSH close allows up to30seconds for the final host receipt. `HostConnection.completed`, not output
EOF alone, reports full verified host completion. Network delivery is not a promise
that an application processed the bytes.

Port revocation, assignment changes and controller expiry use the same durable
stream authority as embedded clients. Interruption closes the forwarding channel
and preserves uncertain delivery/cleanup until reconciled. Arbitrary IP addresses,
Unix sockets, remote listeners and host ports remain unavailable. Live Boat
streaming and physical replacement qualification remain open; see the implementation matrix.


## Stream inspection and cancellation

`streamStatus(sandbox, streamId)` reads the persisted receipt using
`GET /v1/sandboxes/:sandbox/streams/:stream`. It never contacts the host or drives
reconciliation. The response contains only stream/exposure IDs, port, generation,
phase and cancelRequested; host leases and controller identities stay private.
`cancelStream` sends DELETE with an empty JSON object to the same resource. The
stream UUID is the stable cancellation identity. Repeating it targets the same
stream; it never reopens a connection. A202acknowledgement means cancellation was
requested, not that the workload stopped. Poll the persisted receipt; the worker
independently reconciles cleanup. Terminal cancellation replay does not need the
old host. Missing/foreign resources return404; a server without stream transport
returns501. The CLI provides `stream-status SANDBOX STREAM` and
`stream-cancel SANDBOX STREAM`. Use `operation SANDBOX --id STREAM` for the durable
admission outcome. None of these receipts promises application-level processing.

`capabilities()` / `jetski capabilities` reports configured API support separately
from releaseQualified (still false). PTY endpoints are implemented; host reports
the provider's machine-host/platform/runtime capabilities. hostStreams and stream
inspection/cancellation require a configured stream transport. tcpForwarding also
requires an explicitly configured SSH gateway; an embedded HTTP server defaults
that declaration to false. These are feature declarations, not host health,
per-owner authorization or per-sandbox readiness. The Boat host factory supplies
an SSH stream adapter with provider-authenticated host-key pinning. Previews still
require a configured preview listener; live Boat qualification remains pending.


## Isolated HTTP/WebSocket preview transport (experimental)

The optional `jetski/server/preview` module forwards only declared preview routes
to authorized workload port exposures through the core stream coordinator. It does
not resolve or connect to arbitrary destinations. Each route has its own origin,
owner, sandbox and exposure. Shared origins across routes and reuse of a declared
control origin are rejected. Reusing a stale exposure never authorizes a replacement
assignment. Static operator mappings support scoped session grants. Automated origin
provisioning remains operator-owned. Browser/container qualification is described below.

`serve` accepts an optional preview configuration:

```json
{
  "preview": {
    "host": "127.0.0.1",
    "port": 8790,
    "controlOrigins": ["https://control.example.com"],
    "routes": [
      {
        "origin": "https://workspace.example-preview.net",
        "owner": "OWNER_ID",
        "sandbox": "SANDBOX_UUID",
        "exposure": "EXPOSURE_ID"
      }
    ]
  }
}
```

Terminate HTTPS in an operator-owned reverse proxy, preserve the original Host,
and route only declared preview origins to this listener. Use a dedicated preview
site separate from control-plane applications. HTTP is accepted only for loopback
qualification origins. The default bind remains loopback. Routes use the same
bearer principals as the API; every request and WebSocket upgrade is authenticated
and owner-checked. A supplied browser Origin must match the preview origin.
Authorization, Cookie, forwarding metadata and hop-by-hop credentials are stripped
before workload delivery. Workload Set-Cookie is stripped too. Responses receive a
sandbox CSP with workers and framing disabled, no-store, no-referrer and nosniff.
Application cookies, service workers and iframe embedding remain unsupported.
Browser sessions remain experimental; tested browser behavior is described below.
Embedded deployments can provide their own identity adapter, but must qualify the
browser/session boundary before enabling it for users.

The proxy streams binary HTTP bodies and WebSocket frames with backpressure. HTTP
uploads are capped at64MiB, headers at32KiB, concurrent requests at64, admission at
30seconds and connection lifetime at1hour. It verifies WebSocket version/key/accept
and selected subprotocol before relaying an upgrade. No bytes are automatically
replayed. The `x-jetski-stream-id` response header identifies the persisted stream
receipt. Response EOF is not authenticated host completion; inspect that receipt
when cleanup/delivery verification matters. Socket adapters preserve directional
EOF and allow at most30seconds for the final host receipt. Closing the preview
service aborts owned streams, closes upgraded sockets and awaits its handlers.

Local tests cover exact1MiB HTTP transfer, valid binary WebSocket exchange,
authorization/origin denial, credential stripping and stalled-auth shutdown.
Hosted transport qualification is recorded in implementation.md; a fixture socket
test alone does not establish browser usability, live provider recovery or release
acceptance.

### Scoped preview sessions (experimental)

With a configured route, `preview-open SANDBOX EXPOSURE --origin ORIGIN --id ID`
(or SDK `createPreviewGrant`) returns a bootstrap URL. Treat this URL as a secret.
Its fragment carries a 60-second bootstrap credential; the bootstrap page removes
the fragment before exchange. Redemption sets a host-only Secure, HttpOnly,
SameSite=Strict cookie. No control-plane token is embedded in workload HTML.
Sessions expire 15 minutes after grant creation and cannot be renewed by replay.
The cookie authenticates HTTP and WebSocket admissions; active connections also
check revocation every second and close at expiry. Generation and exposure checks
remain authoritative. `preview-status SANDBOX GRANT` returns redacted status;
`preview-revoke SANDBOX GRANT --operation ID` durably revokes the session.

Minting and revocation use stable operation identities. Redemption is one-use,
with a stable redemption identity allowing lost-acknowledgement retries during the
original bootstrap deadline. A competing redemption identity is rejected. Private
transactional state retains the credentials for deterministic replay: restrict
access to the database and its backups. Public operation receipts and status never
include them. The initial limit is 4096 retained grants per sandbox; history is not
automatically deleted. Browser or workload cookies are never forwarded upstream.

Local protocol tests cover restart, concurrency, lost acknowledgements, fixed
expiry, malformed metadata, cross-owner/origin denial and active WebSocket
revocation. Disposable CI additionally qualifies Chrome 156 bootstrap navigation,
fragment removal, cookie acceptance and script execution. A combined HTTPS test
loads a page and asset from a real rootless container through encrypted host
control, verifies exact binary HTTP/WSS payloads and durable closed receipts, and
rejects revoked requests without a new host admission. The fixture pins its
one-day certificate key in a fresh browser profile; this does not test public CA
issuance or an operator's reverse-proxy deployment. See CI run41252297444 at
commit fc3298b and the evidence in implementation.md. Other browsers, application
cookies, embedding and full live-provider lifecycle qualification remain outside
this evidence. No universal browser or production-readiness claim is implied.

### Outbound networking

Workloads default to `networkMode: "none"`. Operators may explicitly select
`"egress"` in the Boat host-provider configuration, or in an adopted host's
bootstrap JSON. The policy is part of the immutable installation receipt; changing
it requires a fresh host installation, never an in-place change on an assigned host.
The embedded bootstrap accepts the same policy as its final constructor argument.

Egress uses rootless `slirp4netns:allow_host_loopback=false`; prerequisites fail
closed when slirp4netns is unavailable. Workload requests cannot select network
options or host networking. This blocks slirp's host-loopback route, **not** all
private networks, metadata services or public host interfaces. Use `none` unless
outbound access is required; broader destination restrictions require an external
network policy. See [Podman's network options](https://docs.podman.io/en/v5.7.0/markdown/podman-run.1.html).

### Create from a retained checkpoint

`JetskiClient.copyCheckpoint(id, image, operationId, sourceSandbox, checkpointId)`
creates an independent same-owner copy. The HTTP equivalent is `POST /v1/sandboxes`
with the usual creation fields plus both `sourceSandbox` and `checkpointId`.
Admission returns `copying`; the worker transfers bounded frame batches without
allocating a host. Observe the stable operation until it succeeds, then explicitly
`resume` the resulting stopped sandbox. The destination owns its objects and
retained history independently of the source. It does not share command history.
Deletion during copying records cancellation and waits for the durable outcome;
a publication that wins that race remains acknowledged history. This is a
filesystem copy, not a memory snapshot or an automatically running clone.

The thin CLI exposes the same admission with
`jetski copy SOURCE --checkpoint ROOT --id DESTINATION --operation UUID --image DIGEST`.
Replaying the same arguments observes the existing copy; use a separate stable
operation ID for `jetski resume DESTINATION --operation UUID`.

### Optional lifecycle observations

Pass `events: { emit(event) { /* enqueue in your telemetry adapter */ } }` in
`SandboxManager` options. Embedded integrations can also wrap a `StateStore` with
`observeLifecycle(state, sink)` from `jetski/core`. Do not wrap the same store twice.
The sink receives committed sandbox and operation phase changes with owner/sandbox
scope, timestamp, generation and operation identity. Operation events include
`elapsedMs` from durable admission to that phase; aggregate by operation kind and
outcome for counts and latency metrics. Command arguments, input, output, error
text, credentials and filesystem contents are excluded.

Events are best effort, not a durable audit log. Rollback and uncertain commit
acknowledgements emit nothing, and a controller crash can lose an observation.
Use persisted operation status for recovery or billing. Sink exceptions/rejections
are ignored; use a nonblocking queue and report exporter failures in your adapter.
No telemetry service or network export is enabled by default.
