# Examples

Each numbered folder has its own runnable entry point, dependency manifest and
short setup instructions. Each entry point is TypeScript, with `npm run typecheck`
and direct Node execution. No custom JSON plan/configuration files are needed.
The convenience API is a **local unpublished draft**, not part of npm 0.1.1.

| Example                                               | Demonstrates                                             |
| ----------------------------------------------------- | -------------------------------------------------------- |
| [01-hello-world](01-hello-world/)                     | Minimal client of an existing Jetski server.             |
| [02-hello-world-boat](02-hello-world-boat/)           | Boat token, local storage, no standalone server.         |
| [03-hello-world-r2](03-hello-world-r2/)               | The same one-shot workload with remote R2 objects.       |
| [04-files-and-checkpoints](04-files-and-checkpoints/) | Restore a checkpoint into a new sandbox.                 |
| [05-warm-pool](05-warm-pool/)                         | Sequential same-owner sessions sharing reusable compute. |

See [the shared API](../docs/simple-api.md) for lifecycle and recovery semantics.
Operator configuration and qualification/recovery harnesses remain below.

## Existing use-case recipes

Start with the [README setup](../README.md#get-started). These recipes use an
already configured service and operator-approved image. Examples that create a
sandbox can allocate billable hosts. Tokens stay in the controller/client
environment, never in plans, command arguments or workload containers.

## A workspace that survives its machine

[durable-workspace.ts](durable-workspace.ts) is a small executable SDK walkthrough.
Run `npx tsx examples/durable-workspace.ts --help` for the steps. `init` writes a
private, exclusive-create JSON plan with stable sandbox/operation/command UUIDs;
it makes no network requests. Run `create`, `write`, `stop`, `resume`, `read`, then
`finish` against that same plan. Each mutating step waits for a persisted outcome.

Use it for a notebook's saved files, a document-processing workspace, or a build
workspace between separate requests. Stop publishes files before releasing the
host. Resume constructs a fresh writable container; a warm host may reuse its
verified local archive, while a replacement reads remote storage.

A repeated completed command identity observes that command, not another write.
Keep the plan across failures and preserve uncertain outcomes. These commands
are an ordered walkthrough, not a background workflow engine: do not replay the
whole list after advancing generations. Call `finish` at the end, keep the server
worker running for idle retirement, and retain the plan/checkpoint metadata.
Local storage only survives execution-host loss; use remote storage and metadata
backups for recovery beyond loss of the controller's disk. This walkthrough does
not delete a host or claim to qualify replacement recovery by itself.

## Sequential build or batch jobs on a warm owner-bound host

Use one logical workspace for repeated jobs from the same owner. Start commands
with stable UUIDs and explicit timeouts; observe `commandStatus` and resumable
`commandOutput` before admitting dependent work. An approved image supplies your
compiler/interpreter. For example, commands can run `/bin/sh -ec 'make test'` in
`/workspace` when your image and uploaded files contain that project.

Use `writeFileStream` for inputs and `readFileStream` for bounded output transfers.
A file upload is committed to the execution host; `stopSandbox` is the separate
remote durability boundary. Save/release between sessions if you want to reclaim
workload processes while retaining a warm host. The pool does not run concurrent
assignments on one host. Cross-owner reuse and untrusted shared build caches are
not enabled.

The [Boat configuration](server-boat.json) demonstrates eight-hour maximum leases
and two-to-sixty-minute adaptive idle retention. Neither means a machine stays
warm for eight hours regardless of demand. Fixed idle policy is also available.
On an adopted SSH machine, releasing a host does not stop its provider bill;
external operator automation must retire that machine if desired.

## An authenticated preview or interactive tool

Use an image containing your HTTP server, start it inside the workload, and expose
its container port through `exposePort`. The standalone preview gateway maps an
operator-approved route to the sandbox. `createPreviewGrant` supplies a scoped
browser session; ordinary unauthenticated forwarding is not the default.
WebSocket upgrades use the same authorization machinery.

For a terminal, configure the SSH gateway's public keys mapped to owner identities,
or use the terminal SDK with explicit session IDs, input acknowledgements, resize
and signals. TCP forwarding binds loopback on the CLI side by default. These
interfaces grant workload access, not an outer-host shell. Follow the concrete
[preview, SSH and forwarding configuration](../docs/standalone.md) before opening
an endpoint; host-only provider ports are not sandbox previews.

## Configuration fragments and qualification tools

- [server-boat.json](server-boat.json): automatic Boat allocation, local checkpoint
  store and opt-in adaptive policy; review images, data path and spend bounds.
- [server.json](server.json): explicitly adopted SSH host; operator bootstrap required.
- [storage-r2.json](storage-r2.json): replace the server's `storage` field with this
  object; provision an existing private bucket and scoped S3 credentials separately.
- [durable-operation.ts](durable-operation.ts): local SQLite operation replay,
  with no execution host or cloud account.
- `qualify-*.ts` / `qualify-tty.py`: operator/CI conformance harnesses, not quickstart
  workloads. Some require disposable Linux privileges or separate paid-host approval.

## Compare runtime costs inside a sandbox

Upload [runtime-workload.mjs](runtime-workload.mjs) to a disposable approved Node
workload and execute `node /workspace/runtime-workload.mjs /workspace`. It checks
and times hashing, metadata, write/fsync, subprocess and sandbox-loopback HTTP
work, then removes its own temporary files. Use identical images, limits and
storage when comparing runtimes. Its CPU counters cover the Node process rather
than all child/runtime processes; tmpfs sync timings are not disk durability.

## A browser on its own private desktop

[browser-desktop.mjs](browser-desktop.mjs) needs a reviewed image containing Node
with WebSocket, Chromium under `/ms-playwright` and Xvfb. Inside an independently
isolated container, run:

```sh
node /tools/browser-desktop.mjs /workspace/desktop.png --outer-sandbox-only
```

It creates its own virtual display and trusted local web page, sends a mouse click
and text through browser control, verifies the resulting DOM and saves a PNG.
The explicit flag disables Chromium's nested sandbox for this controlled demo;
it does not qualify untrusted browsing. Keep the outer runtime's isolation and
verified CPU/memory/PID limits. Mount only the demo code read-only, without host
display sockets, profiles, credentials or devices. Fetch output through the
runtime's file/exec interface; host-side copying need not see a user-space
kernel's virtual filesystem. See [selection and boundaries](../docs/runtime-selection.md)
and the [measured comparison](../docs/runtime-fair-benchmarks.md).
