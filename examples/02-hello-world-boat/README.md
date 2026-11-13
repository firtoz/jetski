# Run one command on Boat

Run `echo`, capture `Hello, world!`, publish files and retire the owned host.
Requires Node 24.22.1+, an existing Boat account and a digest-approved image.
Uses the prebuilt `@firtoz/jetski@0.2.1` package; no separate service, root build or
local container runtime is required. Allocated hosts can incur charges.

From this folder:

```sh
npm install
export BOAT_API_TOKEN=your-private-token
export JETSKI_IMAGE=docker.io/library/alpine@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f
npm run typecheck
npm start
```

`runSandbox()` returns after verified save/release/retirement, retaining checkpoints
and output. Each invocation intentionally creates a new logical sandbox. For
several sessions on one live controller, use [warm reuse](../05-warm-pool/).
[boxd](../06-boxd/) uses the same command API with different provider fields;
[R2](../03-hello-world-r2/) changes object storage.

Controller metadata/recovery IDs and local objects live in this folder's private
`.jetski/`, separately from execution-host disk/cache. Back it up. Failed/uncertain
cleanup retains source/journals: inspect original IDs rather than rerunning.
[Recovery](../../docs/failure-recovery.md) · [storage layout](../../docs/storage-locations.md).
