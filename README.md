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
