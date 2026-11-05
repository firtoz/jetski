# Native R2 checkpoint storage

`@firtoz/jetski/storage/r2` provides `R2CheckpointStore` for a native bucket binding.
It uses a structural `R2BucketPort` and loads no framework, database or provider
SDK. The adapter requires Node-compatible hashing; Workers deployments need
`nodejs_compat`. The core and SDK do not import this optional module.

```ts
import { R2CheckpointStore, type R2BucketPort } from "@firtoz/jetski/storage/r2";

export function checkpointStore(bucket: R2BucketPort) {
  return new R2CheckpointStore(bucket, "checkpoints/v1", {
    writeVerification: "provider-sha256",
  });
}
```

The default `readback` policy rereads and hashes stored bytes and logical ranges.
The explicit `provider-sha256` policy additionally requires the native provider's
[validated SHA-256 write contract](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2putoptions).
It hashes the input and every declared logical range, supplies the SHA-256 on PUT,
and validates the returned checksum, key, size, metadata and unique upload version.
Core publication still performs a fresh conditional observation bound to that
exact version and checksum. Custom metadata and an ETag alone are not a proof.

Missing checksum/version capabilities fall back to complete readback; malformed or
conflicting checksums fail closed. A lost write acknowledgement consumes the
immutable identity and requires observation. New processes rebuild their proofs
from stored bytes. Ordinary reads always verify complete object contents before
returning requested ranges. Existing objects need no format migration.

Verified logical-range proofs use an aggregate LRU budget of 16,384 entries,
alongside the 1,024-object limit. Dense compressed packs can retain all accepted
members without forcing a second payload download. Eviction discards trust and
falls back to readback; every reused proof still needs a fresh stored-version
observation.

The validated-write policy advertises four overlapping uploads. Packed transfers
use `putBuffer` to lend their prepared bytes until completion, avoiding a second
payload buffer. Generic streams still copy their chunks, so generators may safely
reuse yielded memory. Native checksum validation rejects a borrowed buffer changed
before storage receives it. The readback policy keeps two uploads and copies both
input forms; neither policy relaxes final publication or failure draining.

Use an explicit private prefix. Reservation markers remain consumed after failed
or deleted uploads; do not expire them or reuse identities. Delete only through the
core's fenced collector. This adapter does not replace writer/reader coordination,
retention pins, publication verification or collection grace.

Both policies pass the storage consistency/recovery contract. Live qualification
also verifies native checksum rejection, exact independent bytes and version-bound
publication without a redundant readback body. These checks do not establish
universal provider durability or hosted performance parity.
