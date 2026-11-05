# Checkpoint storage

Local storage remains the default and lives on the control-plane disk. It does not
protect against loss of that disk. The S3 adapter is implemented behind
`@firtoz/jetski/storage/s3`. Live R2 passed the bounded storage and checkpoint-recovery
checks below on October 31, 2026. **Physical-host replacement, provider outage and
real-grace collection remain unqualified.** The SDK and portable core do not import
the AWS SDK.

Standalone configuration can select an existing bucket and dedicated namespace:

```json
{
  "storage": {
    "kind": "s3",
    "endpoint": "https://ACCOUNT.r2.cloudflarestorage.com",
    "region": "auto",
    "bucket": "sandbox-checkpoints",
    "prefix": "jetski/v1",
    "accessKeyEnv": "CHECKPOINT_ACCESS_KEY",
    "secretKeyEnv": "CHECKPOINT_SECRET_KEY"
  }
}
```

This is a configuration fragment, not a request to provision a bucket. Credentials
are read from explicit environment variables only by the standalone controller.
An optional `sessionTokenEnv` supports temporary credentials. HTTPS is mandatory
for standalone remote storage. Embedded Node callers can construct an AWS `S3Client`
and inject it into `new S3CheckpointStore(client, { bucket, prefix })`.

The adapter requires atomic conditional PutObject, strongly consistent object reads,
complete lexically ordered ListObjectsV2 pagination, preserved custom metadata and
idempotent deletion. These are qualification requirements, not assumptions established
by an S3-shaped endpoint. General-purpose, unversioned namespaces are the initial
target; directory buckets and reclaiming noncurrent object versions are unsupported.
AWS documents [conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
and [ListObjectsV2 pagination](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html).
Cloudflare documents R2's [supported S3 operations and atomic conditional writes](https://developers.cloudflare.com/r2/api/s3/api/).
Provider documentation informs the design; it does not replace live tests.

Objects and reservations use separate owner/sandbox prefixes. Both creates carry
`If-None-Match: *`. Reservation markers are permanent: deleting a blob never permits
its physical identity to be reused. Do not configure lifecycle rules or external
writers that remove reservations or overwrite this namespace. Reservation ACK loss
consumes an identity; data ACK loss can be reconciled by verifying the committed blob.
Failed verification never authorizes releasing the source host.

Each object is at most 8 MiB, matching bounded checkpoint frames. Uploads consume an
async source with a strict declared extent, buffering one bounded object before PUT.
GET and HEAD verification read the entire bounded object, check its byte count and
SHA-256, then return data or a requested range. This deliberately costs extra reads;
range optimization and measured cloud request/transfer costs remain pending.
List pages reject missing/cyclic tokens, foreign or unordered keys, inconsistent
counts, missing objects and corrupt bytes. Enumeration caps at 10,000 pages and
fails instead of treating a partial inventory as complete. The core collector must
finish enumeration and reachability validation before deleting anything.

Local HTTP fixtures exercise actual AWS SDK serialization and parsing, conditional
headers, concurrent admission, reservation/data ACK loss, corruption, owner isolation,
pagination and deletion identity tombstones. They are not proof of provider durability,
consistency under failure, or live R2 compatibility. Automatic wider GC remains gated
by its full independent qualification.

Dependency provenance: `@aws-sdk/client-s3` is pinned to 3.1161.0 in the lockfile and
retains its Apache-2.0 license; no SDK source is vendored. Optional adapter code is
loaded through explicit subpaths or the selected standalone configuration.

## Shared conformance runner

`@firtoz/jetski/testing/storage` exports `qualifyStorage(openSession)`. It runs the same
bounded checks against a supplied adapter factory, closes and reopens the client,
and returns a report with individual checks, adapter-call counts and cleanup status.
Call counts are adapter methods, not billable provider requests. Elapsed time is a
diagnostic, not a matched performance benchmark.

From the source checkout on the supported Node runtime:

```sh
node --import tsx examples/qualify-storage.ts
node --import tsx examples/qualify-storage.ts /private/storage-config.json
```

Without a configuration file it tests a fresh temporary local directory. A file
contains the storage configuration object itself (`kind`, `bucket`, `prefix`, and
so on), using credential environment variable names as above. Specifying a remote
configuration performs real object operations in that existing namespace; it does
not provision resources. Every run generates fresh random owner scopes and checks
they are empty before writing. Fixtures use at most seven identities and 65,539
bytes per object. The runner never deletes objects discovered outside its own
explicit fixture address list.

It attempts fixture blob cleanup on success and failure and verifies empty scoped
inventories. Permanent identity reservation markers remain by design. A failed
cleanup is a failed qualification, with scope identifiers preserved in the report
for recovery. These disposable, unpublished blobs are cleaned directly; this is
not a 24-hour-grace collector test and must not be represented as one. A successful
run proves the listed functional checks only, not outage durability or physical-host
replacement. Protocol fault-injection tests remain a separate part of the suite.

The executable S3 qualification forces one-entry list pages, exercising continuation
tokens with a small fixture. Normal standalone operation defaults to 1,000 entries
per page; `listPageSize` can set a smaller bound.

## Scoped collection inventory

Collection excludes admitted readers/writers and lifecycle restore references. It
validates all root descriptors and recognized payloads, completes scoped object
enumeration, then verifies retained reachability before any deletion. An omitted
known object that still exists, duplicate/foreign entries, a failed listing, or
ambiguous observation metadata stops collection. The collector remains excluded
until the same operation is safely resumed.

Each inventory attempt persists pages of 64 objects and an explicit completion
receipt. A restarted attempt re-enumerates from the beginning; partial pages never
authorize deletion. The current core has a 100,000-object inventory ceiling and
holds the completed map in memory. S3 enumerates provider pages; local storage
currently reads directory names before yielding entries. This is bounded core
qualification, not an unlimited-scale claim.

Previously unreferenced objects become eligible only 24 hours after their durable
first observation, with a fresh complete inventory and retained-root check. An
object published into a checkpoint during that interval is protected by its root.
Retired checkpoint objects keep their separate retirement grace. Immutable object
IDs and persistent observation records let a lost deletion acknowledgement retry
the same object after restart. Observation and collection receipts remain in the
metadata database; automatic metadata compaction is not implemented. Tests use an
injected clock, not an elapsed real-time cloud qualification.


## Live R2 evidence and checkpoint recovery runner

On October 31, 2026, the storage runner passed all 12 checks against a private,
isolated R2 bucket using a seven-day, bucket-scoped object credential. It used
one-entry list pages, took 5,361 ms, and cleaned all six admitted fixture blobs.
Permanent identity markers remain. This single run is functional evidence, not a
performance comparison or a guarantee about every S3-compatible provider.

`examples/qualify-checkpoint-storage.ts` uses the same optional storage configuration:

```sh
node --import tsx examples/qualify-checkpoint-storage.ts
node --import tsx examples/qualify-checkpoint-storage.ts /private/storage-config.json
```

It creates a fresh random scope and temporary SQLite database. Two independently
compressed binary frames exercise committed-upload acknowledgement loss, database
and storage-client reopening, recovery without rereading the uploaded source,
changed-frame-only upload, stable operation replay, retained shared-frame recovery,
pins/readers, and committed-deletion acknowledgement loss followed by reopening.
It checks all reconstructed binary bytes and deletes only explicitly admitted
fixture objects. Failure retains the local state directory and reports safe scope
identifiers; provider exception details and credentials are not printed.

The same harness passed all 11 checks on local storage and live R2. R2 took
4,213 ms and made exactly two adapter `put` calls: one initial frame and one changed
frame. Both fixture blobs were cleaned; identity markers remain. Acknowledgement
loss is injected after an adapter returns, not by disrupting the provider network.
The collector uses a synthetic clock in this disposable scope; this is **not** an
elapsed 24-hour cloud-GC test. The fixture tests frame bytes and publication, not
filesystem extraction, execution-host replacement or a full API workflow. Live
S3-backed host recovery and matched end-to-end performance remain acceptance gates.

## Bounded publication verification

Adapters may declare `verificationConcurrency` from 1 to 4 for overlapping
independent `head` checks. Omission remains serial for custom adapters; the local
and S3 adapters opt into four. Publication, release and positive-absence recovery checks use bounded batches.
Publication checks each distinct immutable identity
once, preserves manifest order, and rejects conflicting duplicate metadata. Failed
batches drain before rejection and later batches do not start. The final
transaction rechecks the writer and generation before publishing. This capability
does not relax the adapter's byte/hash verification contract or the S3 upload
readback requirement. Source reads remain separately opt-in.

Adapters may also opt into `transferConcurrency` from 1 to 4. Local and S3
adapters enable two transfers; custom adapters remain serial by default. Native R2
validated writes enable four. Optional `putBuffer` lets the packed path lend its
already-prepared bounded buffer until the adapter promise settles, avoiding a
second payload copy. It has the same integrity and immutable-identity contract as
streaming `put`; callers must keep the buffer unchanged until completion.
Reuse observations finish in their own bounded verification phase before any
upload begins. Missing candidates can be repaired from the retained capture.
The save pipeline divides the source's existing read budget across that batch,
never exceeding four concurrent range reads and the adapter's upload bound. It drains
all started transfers on failure and preserves per-frame upload identities for
replay after lost acknowledgements. Plain frame transfers serialize with a serial
source; packed transfers can overlap serial preparation with bounded uploads.

New captures start with 1 MiB independent gzip frames. After 1,024 frames and
again after 2,048, capture doubles the bound up to 4 MiB. This deterministic
large-archive policy keeps metadata within the bounded control-response envelope. Readers continue accepting the
previous 4 MiB frames, independently of capture defaults. The smaller default
reduces changed-byte amplification but increases object counts; hosted latency
and request-count acceptance remains part of the performance qualification.


Cold imports advertise a durable `chunkBytes` limit in their begin receipt. New
hosts accept 512 KiB chunks, within the existing 1 MiB control-request envelope;
hosts or pending imports without that field retain 256 KiB. Each acknowledgement
still follows file fsync, directory synchronization and durable progress recording.
Verified frame tails are coalesced in one bounded chunk buffer. Lost-journal
replay compares already written bytes before advancing. This reduces
control calls and sync points without acknowledging buffered data. Direct bulk
transport and hosted cold-restore performance remain under evaluation.


## Verified object ranges

Storage adapters can optionally implement `verifyRanges(address, ranges)`. Each
range includes byte offsets and an expected SHA-256. The method proves both the
complete object and each requested slice; a whole-object hash alone is insufficient.
Core callers use bounded full readback when the capability is absent. The shared
adapter contract rejects a deliberately false slice digest, including after reopen.

The S3 adapter derives slice hashes from fully verified response bytes. It reuses
those proofs only after conditional verification of the same object. New ranges,
changed validators, process restart and disabled caching require fresh bytes;
invalidated in-flight receipts fail closed. Derived hashes are bounded to 128 per
cached object, without retaining payload bodies. Local storage uses the portable
fallback. Both paths pass the thirteen-check contract, including live R2 and scoped
fixture cleanup. This is a prerequisite for physical packing; packed checkpoint
save and restore are not yet implemented.
