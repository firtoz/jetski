# Run a command through a service

Create a sandbox, run `echo`, capture output and durably stop it using an existing
Jetski service. Requires Node 24.22.1+, an authorized service token and an image
approved by that controller. Sandbox creation can allocate billable compute.

From this folder, install the prebuilt `@firtoz/jetski@0.2.1` package:

```sh
npm install
export JETSKI_URL=http://127.0.0.1:8788
export JETSKI_TOKEN=your-private-server-token
export JETSKI_IMAGE=your-approved-image@sha256:YOUR_DIGEST
npm run typecheck
npm start
```

Output: `Hello, world!`. Stop verifies publication and releases the assignment;
the independent service continues bounded idle maintenance and retains history.
Objects/metadata live with that controller, not automatically on this client.
[Storage layout](../../docs/storage-locations.md).

Each invocation creates a new sandbox. For recovery across client-process death,
persist IDs through `onOperation` before dispatch or use explicit durable IDs. A
timeout does not cancel work; inspect the original outcome rather than replaying
the whole example. Binary output stays available as bytes, text is strict UTF-8,
and nonzero exits retain captured output in the error cause.
[Recovery](../../docs/failure-recovery.md) · [API](../../docs/simple-api.md).
