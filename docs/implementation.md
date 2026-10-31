# Implementation and qualification

## Objective

Build an independent MIT-licensed public `firtoz/jetski` repository: portable
TypeScript core/SDK, optional Node HTTP server and thin CLI for durable sandboxes
on reusable compute. Clean history; generic public source/docs/examples/fixtures
and commit messages. Workload integrations remain client responsibilities.

## Approved scope and constraints

Host providers: Boat allocation and explicitly adopted SSH Linux hosts. Initial
platform Linux x86-64. Runtime: rootless Podman; one active assignment per host,
no cross-owner reuse. Default zero warm minimum, demand creation, ten-minute idle
retention, one host per owner with excess queued; configurable owner capacity.
Boat lifetime bounded to one hour. SSH hosts are operator-owned and never powered
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

## Acceptance matrix

| Gate                       | Required evidence                                                                                                    | Status      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------- |
| Independent repository     | MIT, clean history, provenance, CI, exports, executable generic example                                              | In progress |
| Independent vertical slice | SQLite/local storage, SSH-adopted Linux, Podman, server/SDK/CLI shell+file checkpoint/recovery                       | Open        |
| Boat and S3                | Both host/store adapters pass contracts; R2 and fresh-host recovery                                                  | Open        |
| Pool lifecycle             | owner exclusivity, one assignment, bounded queue/idle/expiry, restart/fencing                                        | Open        |
| Durable execution          | replay/lost ACK/restart/uncertainty/cancel/resumable streams                                                         | Open        |
| Filesystem fidelity        | bytes/modes/symlink/hardlink/Unicode/empty/rename/delete/large/partial transfer                                      | Open        |
| Incremental checkpoints    | cold/cache hit/miss/corruption/changed frames/fresh replacement                                                      | Open        |
| Safe GC                    | reader/writer/publication races, complete paginated listings, corrupt metadata, repeated/failed deletion, real grace | Open        |
| Security                   | cross-owner denial, secrets isolation, process/listener/mount cleanup, unsupported capability rejection              | Open        |
| Interactive transports     | SSH auth, PTY resize/signals, streams, HTTP/WS previews, binary TCP                                                  | Open        |
| Server recovery            | SQLite atomicity, restart pending operations, scheduler recovery, local/S3 parity                                    | Open        |
| Staging integration        | independent client workflow and replacement recovery, pinned dependency                                              | Open        |
| Matched benchmark          | same durability boundary; starts/sessions/readiness/save/bytes/requests/idle compute, failures retained              | Open        |
| Release                    | main CI green, test resources cleaned, limitations documented                                                        | Open        |

## Operational boundaries

Do not alter the separate real-grace experiment scheduled November 1, 2026 at
12:20 UTC: its clock, checkpoint references, active generation and recovery budget
are reserved. New paid-host experiments require a separately approved allowance.
No infrastructure purchases, wallet top-ups, new snapshots, or operator desktop
modifications. Local qualification first. Keep private operational receipts outside
this repository. Public content must not name downstream private applications or
workload-specific products.

## Current evidence and next actions

2026-10-31: initialized empty main branch; no historical source imported. No host
allocated, workload executed, checkpoint deleted or paid experiment initiated.
Implemented portable operation journal, SQLite transactional adapter, isolated SDK
entry point, immutable local object storage and an initial checkpoint registry.
Eight tests pass on Node 24.22.1: restart/lost ACK, identity conflict, stale fencing,
transaction rollback and escaped-handle rejection, owner/path isolation, upload
integrity, tombstone identity reuse, range reads, retained-root verification,
reader/writer exclusion and simulated minimum-grace collection. Build and Biome
lint pass. npm audit reports zero dependency vulnerabilities. No third-party source
has been copied; existing host Python extraction still needs provenance review.

These are foundation tests, not adapter or hosted qualification. The registry's
initial collector handles known retired frames only; complete orphan enumeration,
pagination, resumable deletion receipts, runtime schema validation and bounded
registry growth remain open. Core registry generation is not yet integrated with
host fencing. No lifecycle service or host runtime is wired. The SDK currently
exposes operation lookup plus a generic authenticated request. Do not advertise
v1 API completion or filesystem checkpoint fidelity yet.

Next: finish storage/registry fault contracts; add the independent server/CLI and
SSH/Podman vertical slice, retaining normal Python host modules where justified.
The operator desktop has not been modified; supported Node was obtained via an
isolated npm exec tool cache, without changing the system runtime. No cloud spend.
No adapter or performance claims qualified yet.

At each continuation read this file, inspect actual git/check state, update closed
gates with evidence, and pursue all remaining gates. Full implementation is the
objective; scaffolding alone does not satisfy acceptance.
