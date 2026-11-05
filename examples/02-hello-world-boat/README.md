# Hello world directly on Boat

A self-contained embedded example. No standalone server or custom JSON config.
Compare [hello world on boxd](../06-boxd/): only the provider block differs.
Uses the local, unpublished API; published 0.1.1 does not include this helper.
Requires Node 24.22.1+ and an existing Boat account. Running it can incur host charges.

Run `npm install` once in the repository root (it builds Jetski automatically).
Then, from this folder:

```sh
npm install
export BOAT_API_TOKEN=your-boat-token
export JETSKI_IMAGE=your-approved-image@sha256:YOUR_DIGEST
npm run typecheck
npm start
```

The image must contain `echo` and satisfy the runtime's image contract. Boat
bootstrap runs on allocated hosts, never on your laptop. Credentials stay in the
controller, outside workloads. `.jetski/` holds SQLite metadata and recovery IDs;
keep it private and retain it on failure. Each invocation creates new logical
sandboxes intentionally. To continue existing work, use `jetski.get(id)`.

Local checkpoints live on this controller's disk, independently of Boat hosts.
They survive execution-host replacement, but not loss of the controller disk.
For remote objects see [the R2 example](../03-hello-world-r2/).

`runSandbox()` returns only after a durable save, assignment release and owned
host retirement. It keeps the checkpoint and captured command output. For reuse
across multiple sessions use [openJetski](../05-warm-pool/) instead.

An uncertain save/cleanup rejects and retains its source and journals. Do not
rerun blindly: inspect the recorded operation IDs and reopen the same controller
state. A crash-stale lock requires the [recovery procedure](../../docs/standalone.md)
after confirming no controller remains. See [the shared API](../../docs/simple-api.md)
for observation timeouts, lifecycle boundaries and advanced operations.

Storage location: [where data lives](../../docs/storage-locations.md). “Local”
means the controller machine: this script for embedded examples, or the remote
server for a server-backed client. Relative embedded data paths use the process
working directory. Boat's live disk/cache is separate from the checkpoint store.

The entry point is TypeScript (`index.ts`), run directly by Node 24.22.1+ without
an extra runner. `npm run typecheck` checks it with strict TypeScript settings.
The environment helper checks required values and returns a `string`, so no
non-null assertions or casts are needed for credentials/configuration.
