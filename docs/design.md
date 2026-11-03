# Jetski v1 design and scope

This is the agreed scope, not a statement of completed support. Current work and
acceptance status live in [implementation.md](implementation.md).

## Architecture and contracts

Host providers: Boat allocation and explicitly adopted SSH Linux hosts. Initial
platform Linux x86-64. Runtime: rootless Podman; one active assignment per host,
no cross-owner reuse. Default zero warm minimum, demand creation, ten-minute idle
retention, one host per owner with excess queued; configurable owner capacity.
Boat lifetime defaults to one hour. Opt-in lifecycle policy supports bounded longer
leases and adaptive idle decisions; see the [active qualification](goals/adaptive-host-lifecycle.md).
SSH hosts are operator-owned and never powered
off or deleted. Bootstrap validates namespaces, cgroups, subordinate IDs,
filesystem and runtime versions. Images require operator-approved OCI digests.
Example image is generic Linux. EC2, Daytona, Cloudflare Containers, concurrent
placement and Firecracker are extension targets only; managed sandboxes require
contracts distinct from installable machine hosts.

Boundaries: host provider, runtime, immutable streaming checkpoint store,
transactional state, durable scheduler, authenticated encrypted transport,
identity/policy and structured event sink. Core cannot depend on filesystem,
provider secrets or framework bindings. Separate package subpath exports prevent
SDK/core imports loading database/SSH/provider implementations. Ordinary Python
host modules may be extracted only after provenance review.

API v1 covers sandbox create/inspect/list/stop/resume/delete; command start/status/
cancel and resumable output cursors; bounded file streams; checkpoint inspect/
create/pins/restore; terminals, previews, TCP forwarding; capabilities and durable
operation status. Stable operation identities and persisted outcomes prevent
blind replay after uncertain command completion. Versioned host protocol fences
stale generations; credentials stay outside containers.

Checkpoint quiesces execution and leaves the sandbox stopped. Stop additionally
releases the host only after durable verified publication. Resume builds a fresh
writable sandbox. Failed/uncertain saves preserve and quarantine source. Persistent
paths initially /workspace and /home/sandbox; no kernel/RAM/entire-host snapshots.
Local storage is on control-plane disk, not executor; remote S3-compatible storage
(including qualified R2) protects against control-plane disk loss.

Incremental independently compressed immutable frames; bounded reconstruction;
exact bytes, modes, symlinks and hardlinks. Local cache reuse only after verified
durable publication. Readers/writers and retained roots coordinate transactionally;
stale generations rejected. GC requires complete reachability, minimum 24-hour
grace, fail-closed ambiguity, durable journals, explicit pins and no silent expiry
of acknowledged history. No cross-owner deduplication. Adapters must pass failure
and consistency contracts; plugins cannot bypass verification/fencing.

Transfers may prepare unpublished immutable objects before publication. Only a
verified, fenced root makes a checkpoint restorable or permits source release;
publication changes metadata rather than copying payloads. Failure leaves the
last acknowledged root authoritative. Restore hashes, validates and unpacks in a
single forward pass into isolated staging. Final ownership, modes and inode
synchronization precede atomic directory publication and its durable ready
receipt. A local cache candidate passes scope and file-metadata checks first;
its bytes must still pass the complete streamed proof before use. Corrupt cache
candidates may fall back to remote bytes only before publication with unchanged
authority. Valid-source I/O failures and uncertain ready acknowledgements remain
failures. Execution, file access and previews stay blocked until verified ready.
Any future prefetch from an unpublished save must remain isolated and wait for that same publication gate;
it must not expose provisional bytes to commands, file APIs or previews.

Standalone: SQLite state, durable worker loop, bearer owner authentication,
public-key SSH gateway (never an outer-host shell), PTY stdin/resize/signals,
authenticated HTTP/WebSocket previews and TCP tunnels. CLI forwarding binds
loopback. Embedded clients inject state/scheduling/transports without a mandatory
standalone service. SDK/core remain portable.

Integrate a downstream client only after independent qualification, using pinned
commit/release dependencies, starting with new staging workspaces. Legacy readers
and migration stay client-side; idle adoption follows independent restore proof.
One authoritative backend per workspace; rollback must preserve acknowledged
checkpoints and prevent competing writers. No production cutover, npm publication,
or public hosted-compute service in this implementation.

The [host runtime boundary](runtime.md) defines trusted lifecycle/execution
composition and the remaining qualification requirements for alternate backends.
