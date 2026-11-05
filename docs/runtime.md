# Host runtime boundary

The trusted host composition uses `RuntimeBackend` in
`host/runtime_backend.py`. It supplies a `SandboxRuntime` for create, quiesce,
remove and confirmed-absence checks, and an `ExecutionRuntime` for command,
terminal and forwarding sessions. Control dispatch, command workers and the
stream broker use this boundary. Runtime-specific readiness probing is supplied by
the same backend; common platform checks and host identity remain supervisor-owned. The supplied `PodmanBackend` is the only
installed and qualified implementation.

Runtime selection belongs to the operator-owned host bundle. Workload requests
cannot name a Python module, choose a backend or replace host credentials.
An alternate bundle must use the same backend in all entry points, including
workers launched after the controller exits. A per-call test injection is not a
persistent deployment configuration.

## Adapter obligations

- Preserve the versioned lease and lifecycle receipts. A stale lease must be
  rejected before any effect; shared host journals own admission and replay.
- Keep runtime identities scoped to the assignment. Reconnection observes the
  same command/session identity and never redispatches an uncertain start.
- Quiescence must prove that execution and listeners have stopped before capture.
  Removal and absence must be positively confirmed. A timeout is uncertainty.
- Provide bounded binary execution streams and protocol-v1 supervisor/relay
  framing for exit status, terminal control and TCP forwarding. EOF alone is not
  successful command completion.
- Keep image approval, process/resource restrictions, persistent mount policy and
  credential isolation at least as strict as the shipped runtime.
- Leave checkpoint publication verification, retained-root accounting, generation
  fencing and GC decisions in the shared controller and journals.

The supplied installer and advertised host capabilities currently target rootless Podman. Supporting
another backend requires matching bootstrap/capability negotiation and the complete
lifecycle, security, execution and recovery conformance tests; replacing a factory
alone does not establish support. Managed-sandbox providers also require a distinct
adapter contract and must not be assumed to permit host-runtime installation.

## Experimental storage selection

The trusted host configuration accepts `storageMode: "fuse-overlayfs"`; omission
keeps Podman's default selection. Boat's standalone host configuration and both
bootstrap constructors accept the same option. SSH operators put it in the host
bootstrap JSON. This is an experimental option awaiting hosted qualification.

Bootstrap requires `/usr/bin/fuse-overlayfs` and `/dev/fuse`, writes only the
dedicated runtime account's configuration before pulling images, and refuses an
existing store without the identical configuration. It never resets a store or
changes a host-wide storage policy. Readiness must report overlay with the exact
requested mount program; installing the binary alone is insufficient.

This option targets the initial image-layer copying associated with rootless
`keep-id` on native overlay, described in [Podman's performance guidance](https://github.com/containers/podman/blob/main/docs/tutorials/performance.md#choosing-a-storage-driver).
It does not change persistent paths, checkpoint formats or user isolation. Measure
startup and workload I/O before choosing it; there is no universal performance claim.

## Host bundle upgrades

Boat bootstrap receipts bind both the host source bytes and installation policy.
Changing either requires host replacement. The provider checks this identity
during inspection too, so deploying a changed bundle while old hosts remain
assigned can prevent their normal reconciliation. In-place host upgrades are not
supported.

Keep the old controller build available while draining its assignments. Verify
durable checkpoint publication, release assignments and retire owned hosts before
activating the new bundle. If a save or placement is uncertain, retain its journal
and source; use explicit recovery only after provider-confirmed loss and selection
of a verified retained checkpoint. Never clear bootstrap receipts to force an
upgrade or treat a transport timeout as host disappearance.

Adopted SSH machines remain operator-owned. Apply host changes only after workloads
are safely stopped and released; replacing an installation does not authorize
deleting or powering off the machine.

## Embedded preview compatibility

The standalone Node preview server uses HTTP custom connections. A local Workers
probe with compatibility date `2026-10-01` rejected `http.request`'s
`createConnection` option before invoking it. Node compatibility flags alone do
not qualify that server for an embedded platform.

Optional `jet-ski/transport/http`, `jet-ski/transport/websocket` and
`jet-ski/server/preview-fetch` exports provide portable alternatives without loading
host SDKs or the Node server. Transports consume already-authorized core host
connections. The Fetch gateway uses durable preview sessions, a separate configured
preview origin, secure HttpOnly cookies and recurring authority checks. The caller
supplies the platform socket upgrade and request-lifetime supervision.

HTTP requests have a 30-second total deadline, 32 KiB headers and 64 MiB bodies.
The strict [RFC 9112](https://www.rfc-editor.org/rfc/rfc9112.html) response decoder
rejects ambiguous framing, unsupported transfer codings, malformed fields and
truncation. Credentials and hop-by-hop headers are filtered. Response completion
requires the independent host receipt; errors and cancellation abort the stream.

WebSocket helpers validate the handshake, disable extensions, preserve coalesced
bytes and text BOMs, and enforce 8 MiB messages and 4,096 fragments. Client input
queues are bounded to 16 MiB/256 frames; close exchange has a five-second deadline.
The event-socket adapter sets `binaryType` to `arraybuffer` and limits cumulative
output to 64 MiB or 65,536 messages. It also checks `bufferedAmount` when available;
the tested Workers runtime lacks that metric. Limits reject before sending rather
than silently dropping or replaying bytes. Connections have a one-hour maximum,
and the gateway's session expiry or revocation can close them earlier.

The gateway rejects cross-origin redemption and duplicate cookies before opening
workload streams. Authentication revalidation runs once per second with a
three-second authority-call deadline. The default response policy prevents preview content from being embedded
and blocks its service workers. `frameAncestors` can explicitly allow configured
control origins to embed a preview; other parents are rejected. Cookie policy
remains SameSite=Strict, so embedding must account for browser site boundaries. Do not
serve untrusted workload HTML at the control origin.

Real local HTTP binary transfers, Workers socket-pair exchanges and SQLite-backed
authentication/revocation tests pass. The combined authenticated Workers gateway also passes binary HTTP/WebSocket
traffic, credential isolation and live-session revocation with a simulated host.
Client integration and hosted behavior remain qualification requirements.
