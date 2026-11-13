# Choose checkpoint storage

Local storage is the default: `<dataDirectory>/objects/` on the **controller
machine**, with SQLite metadata beside it. R2/S3 moves objects off that disk;
it does not back up metadata. See [storage locations and backup boundaries](storage-locations.md).
Boat/boxd live files and host caches are disposable execution data.

## Configure remote objects

For embedded Node, follow the [R2 example](../examples/03-hello-world-r2/). For a
standalone controller, supply this storage fragment with credentials in the named
private environment variables:

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

This selects an existing bucket; it does not provision one. Temporary credentials
can use `sessionTokenEnv`. Standalone remote storage requires an HTTPS origin.
For a native Worker bucket binding, use the optional [R2 adapter](storage-r2.md).
Explicit adapter imports keep the AWS SDK out of portable core/HTTP clients.

Keep one private namespace and stable storage identity per controller. Credential
rotation must not change that identity. Do not allow external writers or lifecycle
rules to overwrite blobs, remove reservation markers or expire acknowledged
history. Permanent immutable identities remain consumed after failure/deletion.

## Integrate another store

`/core` exposes the `CheckpointStore` contract; custom stores remain injectable.
An S3-shaped endpoint is not qualification. The adapter must provide:

- Atomic create-only writes and persistent identity reservation, including lost
  acknowledgements and deletion/reopen behavior.
- Strongly consistent reads with verified extent and SHA-256; metadata/ETag alone
  cannot establish correct bytes.
- Complete ordered pagination and unambiguous owner/sandbox-scoped enumeration.
  Missing, duplicate, foreign, corrupt or partial inventory must fail closed.
- Safe idempotent deletion after the core's complete retained-root/actor checks;
  the store cannot decide retention or release a host.

General-purpose unversioned namespaces are the initial S3 target. Directory buckets
and reclaiming noncurrent object versions are unsupported. Core object size is
bounded to 8 MiB. Respect the negotiated transport chunk sizes rather than assuming
one host protocol's bounds apply to another.

Optional `verifyRanges(address, ranges)` must prove both the full object and each
requested slice hash. Without it, core uses bounded full readback. Reused proofs
require a fresh conditionally verified stored version; changed validators, new
ranges or restart require fresh bytes. A false slice digest must be rejected.

Adapters can declare bounded verification/transfer concurrency from 1 to 4;
omission is serial. Every started worker drains before failure returns. Optional
`putBuffer` follows the same immutable byte/hash contract as `put`; its caller
keeps borrowed bytes unchanged until the promise settles. None of these options
weakens publication or creates a retry permission after uncertainty.

## Retain and collect safely

Pins protect acknowledged checkpoints. Stopping or deleting a sandbox does not
silently erase its history; removing a pin does not itself retire a root. Collection
excludes readers, writers and lifecycle references, completes enumeration and
reachability verification, and enforces at least 24 hours of grace. Partial
inventory never authorizes deletion.

The core's inventory ceiling is 100,000 objects, with persisted 64-object pages;
this is a bounded contract, not unlimited-scale support. Unreferenced objects age
from durable first observation; retired roots retain their separate grace.
Observation/collection receipts remain in metadata; automatic metadata compaction
is not implemented. Automatic maintenance is opt-in and is not a retention policy.

[Adapter qualification procedures](../maintainer/testing.md#storage-and-recovery-harnesses)
and [scoped evidence](../maintainer/qualification.md) distinguish fixtures, live R2,
filesystem replacement and real-grace collection. Qualify a new endpoint before
using it for acknowledged data; keep matching metadata/object backups.
