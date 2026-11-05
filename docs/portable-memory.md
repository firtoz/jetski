# Portable process-memory checkpoint design

Opt-in portable process recovery is implemented and qualified on compatible Boat
hosts with R2. The [finite comparison](portable-memory-benchmarks.md) records all
thirty local samples, eighteen hosted cycles, both physical replacements and the
limits of that evidence. Podman stays default.

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
retires. Filesystem-copy APIs copy only the filesystem projection into a new scope;
they do not duplicate process identity or memory implicitly.

The format parser establishes structural consistency, not execution authority.
Restore must verify encoded objects, bounded decoded chunks, complete file hashes,
filesystem equivalence and native compatibility before any instruction executes.

## Portable policy and filesystem identity

The old local memory seal deliberately includes physical inode/lease identity.
Keep that path unchanged. Portable compatibility compares logical policy:
first verify physical rootfs, persistent mount and cgroup paths against trusted
host configuration; then normalize only those paths, runtime state location and
source lease annotations. Keep all remaining OCI resources, command, mount,
capability and runtime flag policy in the digest. Host/runtime artifacts are
separately pinned. Never normalize an unexpected path or erase isolation policy.
CPU features must be an explicit nonempty sorted baseline actually exposed by
runsc and supported on the target; the full source host feature list is not a
portable contract.

Fresh filesystem inodes are expected on another host. The proposed proof reuses
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

## Experimental API integration

A supported assigned gVisor host advertises `portableMemoryVersion: 1`.
`client.suspend(sandboxId, operationId, {codec: "gzip", chunkBytes: 1048576,
reuse: true})` requests remote memory publication alongside the matching filesystem.
Omitting the third argument preserves same-host memory suspension. Embedded callers
supply trusted bounded codecs through `ManagerOptions.memoryCodecs`; the standalone
service includes identity and gzip. Gzip is available from `@firtoz/jetski/storage/memory-codecs`.
The CLI accepts `suspend ID --operation UUID --memory-codec gzip`, with optional
`--memory-chunk-bytes N` and `--no-memory-reuse`.

Observe the saved operation before using `resume-memory`. A local compatible image
remains the warm path. When that source is definitively unavailable or safely
released, a portable root can reconstruct memory on a compatible replacement.
Inspect `memoryPreserved` and `fallbackReason`; filesystem-only fallback explicitly
reports process-state loss. Unknown native effects retain their reader and target
quarantine for observation. Both compressed-full and incremental physical R2
recoveries passed, with the first pre-effect parent-policy failure and its guarded
repair retained in the report. The second replacement used the automatic fix.

The optional Boat binary archive bindings also transfer memory through scoped
outer-host files. Exports are read-only links; imports are bounded disposable
parts checked by the same durable object journal. Range reads skip reused chunks.
Other transports retain bounded control transfers. Transfer links and upload files
never grant execution authority or enter workload mounts. Diagnostics optionally
separate source verification, encoding, reconstruction, target verification and
native restore; timings are observations, not publication receipts.


## Durability boundary and practical defaults

The object store holds immutable file/memory chunks; transactional state holds the
complete retained manifests, operation outcomes and leases. Preserve both. R2
protects against execution-host loss; it does not replace control-plane metadata
backups. Local storage also depends on its control-plane disk.

For compressible, lightly changed memory, gzip with reuse reduced median durable
save time by about 82% in the qualified fixture. Entropy that changes completely
still needed roughly 64 MiB per save. Choose identity for that tradeoff if desired;
no universally fastest mode or default client cutover is implied. Incremental
transfer reuses chunks but still captures and verifies complete native image files.
Use the [measurements](portable-memory-benchmarks.md) rather than synthetic codec
ratios to estimate remote save latency.
