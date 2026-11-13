# Architecture and invariants

Jetski separates logical sandboxes from owner-exclusive physical hosts. The
portable controller owns lifecycle, checkpoint roots and operation authority;
adapters supply machine lifecycle, execution, storage, transactional state,
scheduling, transport and observability. [Acceptance](implementation.md) and
[qualification](qualification.md) describe the supported scope.

## Public layers

- `/node` embeds a controller; `/sdk` connects to an independent service. Both
  expose the shared `SandboxSession`, without a second execution protocol.
- `/core` and explicit adapters support platform integration. Core/HTTP clients
  must not load Node filesystem/database/SSH/provider implementations.
- Neutral host factories compose generic adapters. Product identity, authorization,
  account grants, budgets and durable scheduling remain injected.
- Dedicated machine readiness is separate from sandbox runtime attestation. A
  provider-ready VM cannot authorize workload execution.

## Execution and ownership

One assignment is active per physical host; hosts and content are never reused
across owners. Boat/boxd allocate owned machines, while SSH adopts explicit hosts
and never powers them off. Approved images are digest pinned. Default isolation is
rootless Podman; compatible Python hosts can opt into gVisor. Runtime/network/
resource policy belongs to the immutable trusted host bundle, never the workload.

Commands, lifecycle effects, terminal inputs and streams retain durable identities.
Persist intent before external dispatch. Reconnect observes the same identity;
uncertain effects never authorize blind replay, a second allocation or an isolation
downgrade. A timeout is observation uncertainty, not confirmed cancellation.
Host generation/lease checks fence delayed workers before execution.

Only one authoritative controller schedules a namespace. Platform admission must
arrange durable reconciliation and protect concurrently admitted wakeups. A Node
interval and local directory lock are not a distributed scheduler or lease.
[Platform contract](../docs/embedded-platforms.md#scheduler-contract).

## Checkpoints and release

Checkpoint stops execution; stop additionally releases the assignment after
verified durable publication. Persistent paths are `/workspace` and `/home/sandbox`.
Preserve exact bytes, modes, symlinks and hardlinks. Filesystem resume starts a
fresh writable workload; memory continuation requires its explicit compatible
RAM/filesystem recovery point. No kernel, entire-host or external-socket continuity
is implied.

Objects are immutable, independently verifiable and owner scoped. Transfer can
stage unpublished bytes, but only a verified, fenced root authorizes restore,
source release or cache reuse. Restore validates/hashes into isolated staging;
final ownership, metadata and durable synchronization precede atomic publication.
A corrupt cache may use verified remote bytes before publication. I/O failures and
uncertain ready receipts remain failures. Workload access waits for verified ready.

Readers, writers, restore references and collectors coordinate transactionally.
GC requires complete reachability, fail-closed metadata handling, explicit pins
and at least 24 hours of grace. Acknowledged history never silently expires.
Failed/uncertain saves retain and quarantine their source. Closing a convenience
controller cannot erase history to make cleanup appear successful.

Checkpoint objects and controller metadata have separate durability boundaries.
Local means controller disk. R2/S3 retains objects independently; disk-loss recovery
still needs matching transactional metadata/configuration backups. Immutable
configuration binding and exclusive ownership must survive credential rotation,
reopen, recovery and provider replacement.

## Extensions

Adapters retain the same integrity, fencing, identity and authorization contracts.
An S3-shaped endpoint, a runtime binary or a successful container start is not
qualification. Unsupported requirements fail explicitly. Host assets/policy cannot
be changed underneath an assigned host. Preserve compatibility with acknowledged
checkpoint formats and explicit memory ABI/runtime/image/CPU requirements.

Use bounded operations, explicit cursor/pagination contracts, authenticated scoped
interactive access and nonblocking optional telemetry. Keep provider credentials
outside workloads. Managed-sandbox providers require their own contracts;
installable machine-host behavior must not be assumed.
