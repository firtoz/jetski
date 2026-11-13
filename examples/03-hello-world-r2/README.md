# Keep checkpoint objects in R2

The same one-command Boat example with remote checkpoint objects.
Requires Node 24.22.1+, an existing Boat account and a digest-approved image.
Uses the prebuilt `@firtoz/jetski@0.3.0` package; no separate service, root build or
local container runtime is required. Allocated hosts can incur charges.

Use an existing private bucket and scoped credentials. From this folder:

```sh
npm install
export BOAT_API_TOKEN=your-private-token
export JETSKI_IMAGE=docker.io/library/alpine@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f
export R2_ENDPOINT=https://YOUR_ACCOUNT.r2.cloudflarestorage.com
export R2_BUCKET=your-existing-private-bucket
export R2_ACCESS_KEY_ID=your-scoped-access-key
export R2_SECRET_ACCESS_KEY=your-secret-key
npm run typecheck
npm start
```

Expected output: `Hello, world!`, after verified save/release/owned-host retirement.
Only the storage block differs from [local Boat storage](../02-hello-world-boat/).
R2 holds objects, while private `.jetski/` still holds SQLite, ownership and recovery
metadata. Back up both. The prefix is further scoped by the persisted owner. A new
provider/storage identity needs a separate controller directory.

A failure retains journals and uncertain source state; inspect original IDs rather
than rerunning. R2 credentials never enter the workload.
[Recovery](../../docs/failure-recovery.md) · [storage layout](../../docs/storage-locations.md).
