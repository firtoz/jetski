# Checkpoint storage

Local storage remains the default and lives on the control-plane disk. It does not
protect against loss of that disk. The S3 adapter is implemented behind
`jetski/storage/s3`, but **live S3/R2 conformance and replacement recovery are not yet
qualified**. The SDK and portable core do not import the AWS SDK.

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
