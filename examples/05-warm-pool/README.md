# Reuse compute across two sessions

Keep one `openJetski()` controller alive while two sequential sessions use its
owner-exclusive pool, then close it.
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

`prepareHosts({ count: 1 })` prepares one host/image before demand. It is paid,
one-shot work, not a replenished pool; opening the controller alone creates no host.
A long-running application should persist its preparation ID for observation.

Each `stop()` publishes files and releases the assignment while the controller
remains open. The next session can reuse a healthy idle host within its lease;
expiry/failure can require replacement. One assignment per host and no cross-owner
reuse still apply. Final `close()` retires eligible released hosts. Repeating
`runSandbox()` separately does not provide this lifetime of warm reuse.
[Cost model](../../docs/costs.md) · [preparation contract](../../docs/simple-api.md#prepare-hosts-before-demand).

Controller metadata/recovery IDs and local objects live in this folder's private
`.jetski/`, separately from execution-host disk/cache. Back it up. Failed/uncertain
cleanup retains source/journals: inspect original IDs rather than rerunning.
[Recovery](../../docs/failure-recovery.md) · [storage layout](../../docs/storage-locations.md).
