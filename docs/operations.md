# Operating a single controller

## Deployment boundary

v0.1 targets one controller with local SQLite, Linux x86-64 execution hosts,
Boat or explicitly adopted SSH inventory, and local or qualified S3/R2 storage.
It does not provide HA, multi-controller scheduling, managed backups, a hosted
service, hard per-owner filesystem/storage billing quotas or a contractual SLA.
Run a dedicated controller/volume per trust or billing domain where needed.
Provider outages and force-terminated machines can lose unpublished changes.
Checkpoint acknowledgements cover verified declared persistent paths; memory
recovery additionally requires the documented compatible runtime/platform.

Use Node from `.nvmrc` for the npm server. SSH-managed hosts need an OpenSSH client
on the controller; the container includes it. The controller needs no local Podman,
gVisor, Python or elevated privileges: those run on dedicated execution machines.
Protect configuration, SSH keys, SQLite, logs and storage credentials. Use TLS at
a reverse proxy for remote API access. Explicit `host: "0.0.0.0"` is for container
networking or a controlled private network, not authorization to expose plain HTTP.
The container runs UID1000; provision its persistent data mount for that UID.
Never mount the Docker socket or give the controller privileged mode.

One controller holds `DATA/controller.lock`; another refuses to start. After a
crash, stop and disable **every** controller/restart supervisor using that volume,
verify no controller remains on any machine sharing it, then remove that lock
directory only. Restart one controller. Do not steal locks based on age or delete
SQLite/WAL files. A lock is not a distributed consensus mechanism. Startup failures
release a lock when cleanup is known; hard kills require this manual procedure.

## Resource policy

Default limits: one host per owner, one assignment per host, 1 CPU/512MiB per
workload, zero minimum warm hosts, one-hour leases, ten-minute idle retention.
Longer/adaptive policies are explicit. The owner queue is bounded to1024 tickets;
`maxSandboxesPerOwner` defaults to10,000 retained identities (including deleted
history). Replaying an existing identity remains possible at capacity. Rejected
admission rolls back atomically. Raising a bound does not remove history.
HTTP has256 connections, 1MiB JSON bodies,10s header/30s request timeouts. File and
output bounds are documented in standalone.md. Gate external traffic at your proxy.

Monitor local disk, host free space and object-store usage. Set external capacity
alerts and reserve headroom before admission. There is no complete per-owner byte
quota: use separate volumes/buckets and operational admission controls where hard
storage isolation is required. Never delete retained objects to relieve pressure.
No acknowledged history is silently expired, and GC is not a retention policy.
Keep automatic collection opt-in until your adapter passes its consistency contract.

## Health and alerts

Authenticated `GET /v1/health` returns release/API versions, owner-scoped phase
counts, scheduler timestamps and200/503 readiness. It does not contact providers or
allocate compute. Readiness requires a successful scheduler cycle within30s and
no subsequent failed cycle. Long reconciliation may make it unready; alert and
inspect rather than blindly restarting or replaying commands. Container probes use
the first configured principal's credential; keep its environment available.

The standalone service writes allowlisted lifecycle JSON events to stderr. These
are best-effort observations, not the durable journal; they omit command content,
provider errors and secrets. `reconciliation.failed` means inspect persisted
operations. Alert on stale readiness, failures, queued age, quarantined assignments,
free disk and provider spend. Preserve operation IDs and output cursors. Do not
retry an uncertain command with a new ID. Before shutdown the API stops admission,
then awaits reconciliation and connections; set a sufficient supervisor stop grace.
A controller shutdown does not implicitly checkpoint every running workload.

## Backup and disaster recovery

Back up **SQLite metadata, checkpoint objects, configuration, host keys and needed
secrets**. R2 alone is insufficient. Backups and recovery credentials are sensitive.
RPO is the last acknowledged checkpoint included in both metadata and object backup;
RAM/work after it is outside a filesystem checkpoint. No fixed recovery-time SLA.

1. Stop new admission. Explicitly stop/checkpoint relevant workloads and observe
   successful durable outcomes; unresolved saves stay quarantined.
2. Stop the controller gracefully and disable its automatic restart. Confirm all
   writers/GC are stopped. For local storage, copy the **entire** data directory
   including SQLite/WAL sidecars and `objects/` to independent durable storage.
   Alternatively use SQLite's supported backup/VACUUM INTO API while offline;
   never copy only an open WAL-mode main database file.
3. For remote storage, preserve the full scoped prefix alongside metadata; record
   object inventory/digests. Keep backups immutable/versioned. Never allow lifecycle
   policies or collection to delete their referenced objects independently.
4. Restore to an isolated controller with no access to active provider allocations.
   Verify DB integrity, referenced-object digests and a disposable byte/mode/link
   restore before reconnecting provider control. Existing physical allocations must
   be positively reconciled/retired; a timeout does not prove absence.
5. Fence/disable the old controller before activating the restored authority.
   Never run old and new metadata copies against the same live host/storage scope.
   Retain the original backup until independent recovery passes.

Test your actual backup destination periodically. Existing qualification proves
fixtures, not that an operator's backup is configured correctly. For storage GC,
pins, complete reachability, fencing and the minimum24h grace remain mandatory.
