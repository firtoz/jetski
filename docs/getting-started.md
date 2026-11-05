# Getting started

Choose where the controller runs. Workloads execute on Boat or an explicitly
adopted Linux host, separately from the controller. You do not need to install a
container runtime on your laptop to control Boat workloads.

## Run directly from a Node application

The new local draft exposes `runSandbox` for one command and `openJetski` for a
longer-lived application. These helpers are **not in published 0.1.1 yet**.

From the repository root, using Node 24.22.1 or newer:

```sh
npm install
cd examples/02-hello-world-boat
npm install
export BOAT_API_TOKEN=your-boat-token
export JETSKI_IMAGE=your-approved-image@sha256:YOUR_DIGEST
npm run typecheck
npm start
```

The root `npm install` installs development dependencies and builds Jetski
through its existing `prepare` script. No separate build command is needed for
initial setup. The example's `npm install` links that local package. This is only
for trying the unpublished API from a source checkout; normal package consumers
install a prebuilt release and do not clone or build Jetski.

No custom JSON configuration or separately running server is needed. After editing
Jetski's TypeScript source, run `npm run build` from the root to refresh the build.

The script creates a sandbox, runs `echo`, saves its files, releases its assignment
and retires its owned host before returning `Hello, world!`. Creating hosts can incur provider
charges. The digest-pinned image must be operator-approved and contain the command
you want to run; Jetski does not install an application language stack for you.

The [example code](../examples/02-hello-world-boat/index.ts) uses
`dataDirectory: "./.jetski"` and local checkpoint storage. Because `npm start` runs
from the example folder, its state and objects live in that folder's `.jetski/`
on **your script machine**, not Boat. An absolute data path avoids working-directory
ambiguity in an application. Keep it private and back it up.

Next, try:

- [R2](../examples/03-hello-world-r2/) to move checkpoint objects off the controller disk.
- [Files and checkpoints](../examples/04-files-and-checkpoints/) to restore saved files into a distinct sandbox.
- [Warm reuse](../examples/05-warm-pool/) to run sequential sessions within one controller lifetime.

## Connect to a standalone server

Use a server when several clients need one independently running controller.
The server owns provider credentials, lifecycle scheduling and metadata; clients
send authenticated requests. Closing a client does not stop the server.

The published release supports installation with:

```sh
npm install --global @firtoz/jetski@0.1.1
```

Follow the [README setup](../README.md#get-started) and
[standalone configuration](standalone.md) to configure the host adapter, approved
image, private data directory and authentication, then start `jetski serve`.
The [minimal server-backed example](../examples/01-hello-world/) uses the new local
convenience facade; published explicit CLI/API operations are in the standalone guide.

Here, local storage means the **server's** disk, regardless of where the client runs.
A containerized server needs a persistent volume. See [where data lives](storage-locations.md).

## Know the save boundary

Writing a file or finishing a command does not publish a checkpoint. `checkpoint()`
publishes files and stops execution; `stop()` additionally releases the assignment.
Filesystem resume reconstructs a writable workload; process/RAM continuation needs
an explicitly supported memory checkpoint. Unpublished changes can be lost if a
host disappears.

Keep operation IDs and inspect uncertain outcomes before retrying. Failed saves
retain/quarantine their source; never force-delete it to make cleanup look complete.
The [API guide](simple-api.md) explains IDs, timeouts and shutdown, and
[operations](operations.md) explains backing up metadata alongside objects.
