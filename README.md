# Jetski

Portable, durable sandboxes on reusable compute. MIT licensed.

**Under construction; no release is qualified yet.** See [implementation gates](docs/implementation.md).
The intended first release combines owner-exclusive reusable hosts, rootless
Podman workloads, verified incremental filesystem checkpoints, and authenticated
execution and networking. Filesystem checkpoints do not preserve RAM or kernels.

The portable core has no filesystem, database, provider SDK or framework imports.
Node-only adapters are separate subpath exports. Local checkpoint storage belongs
on the control-plane disk, independently of execution hosts; it cannot recover
from loss of that disk. Remote object storage is recommended for that failure mode.

## Development

Use Node specified in `.nvmrc`, then `npm install`, `npm run build`,
`npm test`, and `npm run lint`. No cloud account is needed for local unit tests.
Do not interpret contract tests as hosted qualification.

A runnable state-only example is available with
`npx tsx examples/durable-operation.ts /tmp/jetski-example.sqlite`. Run it twice:
the second process observes the original running operation and does not redispatch.
This example does not execute a workload. The full sandbox example remains a release gate.

CI exercises real rootless Podman on a disposable Linux runner, including source
deletion and exact filesystem recovery into a new container. This does not yet
qualify replacement hosts, remote checkpoint stores, networking or the server API.

The initial [standalone server and CLI](docs/standalone.md) support queued creation
and command execution over an adopted SSH host. [OpenAPI](docs/openapi.json) covers
currently implemented routes. Full lifecycle and interactive APIs remain in progress.

## Pinned client dependency

Before an npm release, clients can depend on a reviewed full Git commit:
`npm install git+https://github.com/firtoz/jetski.git#<full-commit-sha>`. The Git
prepare hook builds the exported JavaScript and declarations. Import `jetski/core`
or `jetski/sdk` without loading provider SDKs, SSH servers or SQLite. CI verifies
installation from its exact commit into an independent consumer. Use sibling-path
links only for development; retain the pinned version in the client's lockfile.

### Embedded bootstrap assets

`jetski/providers/boat-bootstrap-embedded` exports `EmbeddedBoatBootstrap` and
`BOAT_BOOTSTRAP_MODULES`. Supply a loader returning `{ files, installer }`, where
`files` maps every listed filename to its original `Uint8Array` source and
`installer` contains `host/install_bundle.py`. The `loadBoatBootstrapAssets` function from `jetski/host-assets` supplies the
release's bundled source bytes without filesystem access; pass it directly to the
constructor. Alternatively bundle those assets from the same pinned package at
build time. Do not download unpinned executable source. This
entrypoint avoids controller filesystem access and database/provider-SDK loading;
it still requires Node-compatible crypto, path and Buffer support. The normal
`BoatBootstrap` remains the Node filesystem-backed default. Both paths validate
the complete module set, size limits and identical persisted bootstrap identity.
Changing installed code or policy requires explicit host replacement.
