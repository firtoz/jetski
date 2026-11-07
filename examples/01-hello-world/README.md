# Hello world through a Jetski server

Create a sandbox, run `echo`, then durably stop it. Requires an existing Jetski
server and an operator-approved image. Creating a sandbox can allocate billable
compute on that server. This example does not provision a controller.

Uses the released `@firtoz/jetski@0.2.1` SDK. From this folder
(no root install or Jetski build required):

```sh
npm install
export JETSKI_URL=http://127.0.0.1:8788
export JETSKI_TOKEN=your-server-token
export JETSKI_IMAGE=your-approved-image@sha256:YOUR_DIGEST
npm run typecheck
npm start
```

Output: `Hello, world!`. No recovery-plan/configuration JSON is needed by this client.
Stop waits for verified checkpoint publication and assignment release; the server
continues owner-scoped idle-host maintenance. It does not erase checkpoint history.

Each invocation creates a new sandbox intentionally. The facade keeps IDs stable
within each operation and reports them on failure; it does not retry mutations.
A timeout/disconnect does not cancel remote work. For an application that must
recover after client-process death, supply explicit IDs and persist `onOperation`
before dispatch. Keep errors/IDs and inspect receipts instead of rerunning the
whole example. Binary command output is available as `stdoutBytes`/`stderrBytes`;
text access is strict UTF-8. Use the lower-level streaming SDK for large outputs.

Nonzero command exits reject with captured output available on the error cause; `check: false`
lets callers handle an exit code explicitly.

Storage location: [where data lives](../../docs/storage-locations.md). “Local”
means the controller machine: this script for embedded examples, or the remote
server for a server-backed client. Relative embedded data paths use the process
working directory. Boat's live disk/cache is separate from the checkpoint store.

The entry point is TypeScript (`index.ts`), run directly by Node 24.22.1+ without
an extra runner. `npm run typecheck` checks it with strict TypeScript settings.
The environment helper checks required values and returns a `string`, so no
non-null assertions or casts are needed for credentials/configuration.
