# Files and checkpoints

A self-contained embedded example. No standalone server or custom JSON config.
Uses the released `@firtoz/jetski@0.2.0` package.
Requires Node 24.22.1+ and an existing Boat account. Running it can incur host charges.

From this folder (no root install or Jetski build required):

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

This example writes a file, publishes a checkpoint with `{ releaseHost: true }`,
and pins that version. `jetski.fromCheckpoint(...)` creates a **different logical
sandbox** with its own independently published filesystem checkpoint. It stays
stopped until `restored.resume()`; the original remains stopped. The two printed
sandbox IDs differ, and the restored file has the saved contents.

Releasing the original assignment lets the new sandbox run even with the default
one-host-per-owner limit. A healthy warm Boat may be reused: a new sandbox does
not force a replacement VM. This is a filesystem copy/restore example, not a
physical-host-failure or process/RAM recovery demonstration. The copy belongs to
the same owner and controller/storage namespace; it is not a cross-account import.

Plain `checkpoint()` stops execution but retains the assignment; `releaseHost: true`
also releases it after durable publication. Copy and resume have distinct operation
IDs, so an uncertain resume does not repeat the copy. The source is retained;
this example does not delete checkpoint history. `close()` saves/releases any
remaining assignment and retires released hosts.

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
