# Get started

Choose an embedded controller when your Node application owns sandbox lifecycle.
Choose a standalone service when multiple clients need an independently running
controller. Both return the same `SandboxSession` interface.

## Embed in Node

Follow the [README command example](../README.md#try-a-command), or run the complete
[Boat example](../examples/02-hello-world-boat/). Install the prebuilt
`@firtoz/jetski@0.2.1` package on Node 24.22.1 or newer; no source build, separate
server or local container runtime is required.

Supply a private provider credential and an approved digest-pinned image containing
the commands you need. The example runs `echo`, publishes files and retires its
owned host before returning. Allocating hosts can cost money.

For boxd, install its optional `@boxd-sh/sdk@0.3.0` peer dependency and use the
[boxd example](../examples/06-boxd/). Provider fields, resources and billing differ;
keep a separate controller namespace for each provider/account.

Use `runSandbox(options, argv)` for one command with cleanup. Use
`openJetski(options)` for several sessions and warm reuse; call `stop()` after each
session and `close()` at application shutdown. Repeating the one-shot helper does
not retain hosts between invocations.

Choose an absolute `dataDirectory` for applications. Relative paths resolve from
the opening process's working directory. The directory holds controller metadata
and, by default, checkpoint objects. Protect and back it up.
[Storage locations](storage-locations.md).

## Connect to a service

Use `Jetski` from `/sdk` with the service URL and an authorized token. The
[minimal service-client example](../examples/01-hello-world/) runs a command and
stops its sandbox. The service owns provider credentials, scheduling and metadata;
client exit does not shut it down.

To operate your own service, follow [standalone setup](standalone.md), then
[operations and backups](operations.md). Local storage here means the server's
disk. Containerized controllers require a persistent volume.

## Keep the result

A completed command or file write is not a checkpoint. `checkpoint()` publishes
files and stops execution; `stop()` also releases the assignment. Filesystem
resume creates a fresh writable workload. RAM continuation needs an explicitly
supported memory checkpoint. Unpublished changes can be lost with the host.

Try [files and checkpoints](../examples/04-files-and-checkpoints/),
[remote R2 objects](../examples/03-hello-world-r2/) or
[sequential warm sessions](../examples/05-warm-pool/).
For interruptions, use [existing operation identities](failure-recovery.md): an
observation timeout never confirms cancellation or authorizes replay.
