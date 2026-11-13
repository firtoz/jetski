# Where data lives

**Local checkpoint storage means the disk of the machine running the Jetski
controller. It does not mean the Boat disk.** The controller is either your Node
application (`openJetski`/`runSandbox`) or the standalone `jetski serve` process.
An HTTP SDK/CLI client is separate from the controller.

## Three separate places

| Place                        | What lives there                                                                                                                                      | What it is for                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Controller machine           | SQLite state, operation/lease/generation records, checkpoint references, configuration identity and lock. With local storage: checkpoint objects too. | Authority for lifecycle and retained checkpoints.                                                                   |
| Execution host, such as Boat | Live sandbox `/workspace` and `/home/sandbox`, processes, runtime data and optional verified checkpoint cache.                                        | Running work and accelerating reuse. Host loss can destroy unpublished changes and cache.                           |
| R2/S3, if selected           | Immutable checkpoint objects and storage identity markers. Optional portable memory artifacts use remote objects too.                                 | Recovery independent of the execution host and controller's object-storage disk. Does not replace metadata backups. |

A filesystem checkpoint covers declared persistent paths, not an entire machine
or its RAM. A host cache is an optimization: reuse requires an already published
checkpoint and verification. It is never the sole acknowledged recovery copy.

## Embedded application

For this configuration:

```js
const jetski = await openJetski({
  provider: { kind: "boat", token: process.env.BOAT_API_TOKEN },
  image: process.env.JETSKI_IMAGE,
  dataDirectory: "./.jetski", // On the machine running this Node process.
  storage: { kind: "local" }, // Checkpoint objects on that same machine.
});
```

If the process working directory is `/home/alex/my-app`, the built-in layout is:

```text
/home/alex/my-app/.jetski/
  state.sqlite       metadata and operation journal (plus SQLite sidecars)
  objects/           local checkpoint objects and identity reservations
  controller.lock/   exclusive local controller lock while running
```

The path resolves against the **process working directory**, not the JavaScript
source file's directory. Use an absolute path for a predictable deployment.
If you deliberately run the controller inside a Boat, its local storage would
then be on that Boat; the meaning follows the controller's location, not the
selected host provider.

Change storage to R2/S3 and checkpoint objects go to the configured bucket/prefix.
SQLite, the local controller lock and configuration identity remain in
`dataDirectory`. Existing local object files are not automatically migrated by
changing a setting: the embedded helper rejects a different storage configuration
for an existing identity. Use an intentional, verified migration rather than
pointing existing state at an empty store.

## Standalone server or container

With `jetski serve`, the server machine holds `dataDirectory`. A remote client
can run on your laptop without storing checkpoint objects there. Local storage
on a remote server stays on that server.

In Docker or another container system, local storage is inside the controller
container unless `dataDirectory` maps to a persistent volume. A path named
`/data` is not durable by itself. Mount and back up the volume; do not mount the
controller data directory into workload containers. SSH-managed execution hosts
have the same separation as Boat hosts.

## What survives a failure?

| Failure                                  | Local checkpoint store                                                                    | R2/S3 checkpoint store                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Execution host disappears                | Acknowledged checkpoint recoverable from controller objects and metadata.                 | Acknowledged checkpoint recoverable from remote objects and controller metadata.                 |
| Controller process restarts, disk intact | Metadata and objects remain; reconcile existing operations before admitting replacements. | Metadata remains; remote objects remain; reconcile existing operations.                          |
| Controller disk is lost                  | Requires an independent backup of metadata and local objects.                             | Remote objects alone are insufficient: restore corresponding metadata/configuration backups too. |
| Work changes after the last checkpoint   | Not covered by that checkpoint.                                                           | Not covered by that checkpoint.                                                                  |

These are recovery boundaries, not an availability or zero-loss guarantee. Restore
also requires usable provider access, a compatible runtime and approved image.
Memory resume has additional compatibility requirements; sockets/external services
are not automatically restored by saving process state.

`writeFile()` commits to the live sandbox; `checkpoint()` or `stop()` is the durable
publication boundary. `stop()` releases the workload assignment, and an open
controller may retain the host warm. Embedded `close()` saves/releases known
assignments and retires released hosts; it retains checkpoint history. Failed or
uncertain saves do not authorize destroying the source.

Follow [operations](operations.md#backup-and-disaster-recovery) for consistent
metadata/object backups and single-writer recovery. See [storage contracts](storage.md)
for adapter requirements, pins and safe garbage collection, and the
[R2 example](../examples/03-hello-world-r2/) for configuration.

## Resolved embedded diagnostics

`await controller.resolvedConfiguration()` reports the absolute data directory,
SQLite path or custom state identity, local object directory or remote bucket and
prefix, owner/pool IDs and scheduler kind. It excludes credentials. Relative paths
resolve once against the opening process's working directory; moving the working
directory later must not change the active store. Save the non-secret summary
with backup metadata so operators know which namespace they are recovering.

If reopen rejects a configuration/owner mismatch, compare the original provider,
storage endpoint/bucket/prefix, owner/pool, approved images and custom adapter IDs.
Restore the intended configuration and matching metadata; do not bypass the seal,
move empty stores into place, adopt foreign objects or remove a live lock.
Credential rotation keeps these identities stable: update the token or access-key
values without changing the bound namespace/configuration. A replacement provider
account is a namespace change even if it accepts the same resource identifiers;
custom factories must bind that distinction in their stable identity.

For backup, quiesce the authoritative controller, obtain a consistent SQLite
backup (including committed WAL state), and retain every checkpoint object rooted
by that metadata and its pins/journals. Keep immutable configuration and identity
alongside it; store credentials separately. For restore, stop the old scheduler,
restore matching metadata and objects, reopen the same namespace, inspect pending
operations and reconcile before admitting new work. Never copy a live SQLite
main file alone or treat a bucket inventory as replacement metadata. Detailed
procedures remain in the [operations runbook](operations.md#backup-and-disaster-recovery).
