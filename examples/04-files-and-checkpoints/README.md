# Restore saved files into a new sandbox

Write a file, publish/pin a checkpoint, create a distinct same-owner sandbox and
verify its restored contents and different ID.
Requires Node 24.22.1+, an existing Boat account and a digest-approved image.
Uses the prebuilt `@firtoz/jetski@0.3.0` package; no separate service, root build or
local container runtime is required. Allocated hosts can incur charges.

From this folder:

```sh
npm install
export BOAT_API_TOKEN=your-private-token
export JETSKI_IMAGE=docker.io/library/alpine@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f
npm run typecheck
npm start
```

`checkpoint({ releaseHost: true })` releases the original assignment before the
copy resumes, so the default one-host limit is enough. The original stays stopped;
the new sandbox owns an independent checkpoint and writable files. A warm machine
may be reused: a distinct logical sandbox does not prove physical-host replacement.

This is filesystem recovery, not RAM continuation or cross-account import. Copy
and resume retain separate operation IDs. `close()` saves/releases remaining work
and retires released owned hosts; pinned history remains retained.
[Lifecycle table](../../docs/simple-api.md#lifecycle).

Controller metadata/recovery IDs and local objects live in this folder's private
`.jetski/`, separately from execution-host disk/cache. Back it up. Failed/uncertain
cleanup retains source/journals: inspect original IDs rather than rerunning.
[Recovery](../../docs/failure-recovery.md) · [storage layout](../../docs/storage-locations.md).
