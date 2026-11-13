# Portable memory format and authority

For implementing or reviewing RAM checkpoint changes. Application usage belongs
in [portable memory](../docs/portable-memory.md).

## Independent boundaries

Native gVisor creates ordinary image files while the workload is stopped. The
host adapter turns them into bounded immutable chunks; a codec independently
encodes each chunk. The storage interface owns transport and durable object
verification. The core owns publication, retained references, fencing and placement.
No object-store credentials enter the workload and no store-specific API enters
portable core code. Memory images contain application secrets and remain private.

The version-one portable manifest declares:

- Owner/sandbox, stable checkpoint identity and generation.
- The exact verified filesystem archive SHA-256.
- Runtime archive, host ABI, approved OCI image, logical configuration, platform,
  required kernel and explicit exposed CPU feature baseline.
- Sorted relative file/directory paths, whole-file lengths and hashes.
- Complete ordered chunk extents: decoded length/hash, codec and immutable stored
  object length/hash/address. Both stored and decoded bytes are checked.

A manifest has bounded entries, extents and expansion. It contains no base-root
pointer or executable patches. Incremental saves reuse immutable chunks and emit a
complete new manifest, so reconstruction never follows an unbounded history chain.
Content hashes index reuse; physical object IDs come from persisted upload attempts.
A failed create-only upload can reserve its ID permanently, so retry must observe
its outcome or journal a fresh ID, never overwrite or blindly retry the old name.
Current codec implementations are identity and independently compressed gzip;
codec implementations remain injectable and cannot authorize publication.

## One retained recovery point

A `filesystem-memory` root wraps the existing filesystem metadata and appends all
memory objects to the existing physical retained-reference graph. The registry
checks every object before committing the root under the writer generation. A
missing memory object prevents the combined recovery point from being acknowledged.
Reader/writer/collector exclusion, pins and the minimum GC grace remain unchanged.
Any chunk reused by a later retained root stays reachable after an earlier root
retires. Checkpoint-copy APIs default to the filesystem projection into a new scope;
they do not duplicate process identity or memory implicitly. Explicit
`fromCheckpoint({sourceSandboxId, checkpointId, content: "memory"})` creates a
stopped, same-owner copy of the complete disk/RAM graph. Object identities and
publication metadata are rebound to the target under existing writer/reader
fences; source objects remain unchanged. Call `resumeMemory()` separately on a
compatible runtime. The [Chromium fork example](../examples/07-memory-fork/README.md)
shows two fresh hosts continuing one JavaScript instance independently, with a
recorded demonstration and its measured limits.

The format parser establishes structural consistency, not execution authority.
Restore must verify encoded objects, bounded decoded chunks, complete file hashes,
filesystem equivalence and native compatibility before any instruction executes.

## Portable policy and filesystem identity

The local memory seal deliberately includes physical inode/lease identity.
Keep that path unchanged. Portable compatibility compares logical policy:
first verify physical rootfs, persistent mount and cgroup paths against trusted
host configuration; then normalize only those paths, runtime state location and
source lease annotations. Keep all remaining OCI resources, command, mount,
capability and runtime flag policy in the digest. Host/runtime artifacts are
separately pinned. Never normalize an unexpected path or erase isolation policy.
CPU features must be an explicit nonempty sorted baseline actually exposed by
runsc and supported on the target; the full source host feature list is not a
portable contract.

Fresh filesystem inodes are expected on another host. The portable proof reuses
the verified archive import and records a new physical frozen-tree identity on the
exclusive target assignment. Before native restore, recheck that identity and the
matching retained filesystem root. This must not accept arbitrary new files against
an old seal. Native open-file and deleted-open-file semantics need real qualification.

Publish and restore effects use persisted stable intents and generation fences.
An unknown native effect is reconciled, not replayed. A known incompatible or
unavailable memory image can use verified filesystem recovery only with explicit
process-state loss. An uncertain original writer must not gain a competing target.
Host capture/reconstruction and target import journals are implemented. Target
import begins only after verified filesystem import with an explicit memory-required
barrier; it closes the target fence. Every encoded chunk and reconstructed file is
checked, including after ownership handoff. A durable `restoring` state precedes
native execution. An uncertain effect is observed and quarantined, never replayed;
only known pre-effect stages permit explicit filesystem fallback. The core, SDK, standalone server and CLI use these same journals and guards.
