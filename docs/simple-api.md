# Simple application API (source preview)

These helpers are available from the source checkout, not published 0.1.1.
Examples use `file:../..` for development. Run `npm install` in the repository
root once; its `prepare` script builds Jetski automatically. Each numbered example
then runs independently. A future release can use a pinned npm version.

## TypeScript

The package exports generated TypeScript declarations alongside each JavaScript
subpath. Import public types with `import type`, for example:

```ts
import { openJetski, type NodeOptions } from "@firtoz/jetski/node";
import type { CommandResult, SandboxSession } from "@firtoz/jetski/sdk";
```

`NodeOptions` checks the provider/storage discriminated unions. `create()` and
`fromCheckpoint()` return `Promise<SandboxSession>`; `exec()` returns
`Promise<CommandResult>`. Both controller modes share the same session methods.
The numbered examples use `.ts` entry points and strict typechecks; supported Node
runs their erasable TypeScript directly. Typechecking is explicit (`npm run
typecheck`), since Node's execution does not itself check types.

## Choose a controller

With an existing service, import `Jetski` from `@firtoz/jetski/sdk`:

```js
const jetski = new Jetski({ url, token });
const sandbox = await jetski.create({ image });
try {
  console.log((await sandbox.exec(["echo", "Hello!"])).stdout);
} finally {
  await sandbox.stop();
}
```

Without a service, import `openJetski` or `runSandbox` from
`@firtoz/jetski/node`. The Node helper embeds the same lifecycle controller,
SQLite state and an independent maintenance loop; it opens no HTTP listener.
It does not run workloads on the controller machine. See the executable
[Boat](../examples/02-hello-world-boat/) and [R2](../examples/03-hello-world-r2/)
examples for complete configuration.

`runSandbox(options, argv)` runs one command and closes the controller before
returning. `openJetski(options)` supports multiple sessions and warm reuse until
`await jetski.close()`. Keep the controller alive while the pool is in use.
Opening fresh state allocates no hosts. Reopening existing state can resume
previously admitted work; inspect recorded IDs before admitting replacements.

## Shared sandbox methods

Both modes return the same `SandboxSession` interface:

| Method                                               | Behavior                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `jetski.create({ image })`                           | Wait for an approved digest-pinned image to be running. Embedded mode can use its configured default image. |
| `jetski.get(id)`, `jetski.list()`                    | Attach to existing metadata; attaching does not resume execution.                                           |
| `sandbox.exec(argv, options?)`                       | Start once, observe persisted status, return bounded stdout/stderr bytes and strict UTF-8 views.            |
| `sandbox.inspect()`                                  | Current phase, generation and checkpoint metadata.                                                          |
| `sandbox.writeFile(path, textOrBytes, { mode }?)`    | Digest-checked, bounded upload to a declared persistent path. Not a durable checkpoint.                     |
| `sandbox.readFile(path)`, `readText(path)`           | Verified file bytes or strict UTF-8; default 16 MiB read bound.                                             |
| `sandbox.readFileStream(path)`                       | Pull verified chunks; fail if the file changes between chunks.                                              |
| `sandbox.listFiles(path?, options?)`                 | Explicit directory pagination and version; does not silently truncate a recursive walk.                     |
| `sandbox.checkpoint()`                               | Publish a verified filesystem checkpoint and leave execution stopped, retaining the host assignment.        |
| `sandbox.checkpoints({ after, limit }?)`             | Explicit history pagination.                                                                                |
| `sandbox.pin(checkpointId, name, retain?)`           | Retain/unpin an acknowledged version explicitly.                                                            |
| `sandbox.resume({ checkpointId }?)`                  | Reconstruct a fresh writable sandbox from the chosen/latest filesystem checkpoint.                          |
| `sandbox.stop()`                                     | Publish files and release the assignment; warm retention continues while the controller runs.               |
| `sandbox.delete()`                                   | Explicit core deletion workflow; separate from stopping.                                                    |
| `sandbox.exposePort(port)`, `revokePort(exposureId)` | Durable, generation-bound port permission. Does not create a public URL.                                    |

File writes are limited to 64 MiB by the upload contract. Use
`sandbox.raw().writeFileStream(...)` for bounded-memory upload. `readFile` accepts
`maxBytes` up to that limit; use streaming for larger reads. Empty files and
binary data remain bytes. Text decoding rejects invalid UTF-8.

Execution defaults to a 120-second command timeout and ten-minute observation
window. Nonzero exit rejects with `JetskiCommandError` as the operation error's
cause; captured output remains on `cause.result`. Use `{ check: false }` to handle
exit codes explicitly. Large/live command output uses the existing cursor-based
SDK rather than accumulating unbounded output in `exec`.

## Restore into a new sandbox

```js
const checkpoint = await original.checkpoint({ releaseHost: true });
await original.pin(checkpoint.id, "saved");
const restored = await jetski.fromCheckpoint({
  sourceSandboxId: original.id,
  checkpointId: checkpoint.id,
});
await restored.resume();
```

`fromCheckpoint` works in both HTTP and embedded modes. It creates a distinct,
same-owner sandbox with independently copied checkpoint objects, verifies durable
publication and returns it stopped. No host allocation is needed for the copy;
explicit `resume()` starts the new workload. The original remains stopped.
The approved image defaults to the source sandbox's image; an explicit `image`
is allowed subject to controller policy. Optional `id` and `operationId` identify
the target sandbox and copy operation. Copy/resume have separate recovery IDs.

`checkpoint({ releaseHost: true })` saves once and releases the original assignment,
allowing the target to run with the default single-host limit. Without that option,
`checkpoint()` retains the source assignment. A different sandbox may reuse the
same physical host; copying does not prove physical-host replacement. It copies
filesystem state, not process identity/RAM, across distinct scopes within the same
owner/controller. Source checkpoint pins and target history are independent.
See the [complete example](../examples/04-files-and-checkpoints/).

## Operation identity and recovery

Supply explicit `id`/`operationId` and a durable `onOperation` callback when an
application needs restart-safe admission. The callback is awaited before a
mutation is dispatched. The embedded helper additionally journals generated IDs
in its state store automatically. A timeout or abort bounds observation; it does
not imply remote cancellation. The helpers never automatically replay a mutation
or cancel an uncertain command. `JetskiOperationError.operation` identifies the
sandbox and operation to inspect.

An explicit retry of `stop()` on the same handle reuses its ID within the same
generation. Resume advances the generation and the next stop uses a new ID.
For other mutations, reuse the originally recorded ID only with the same input
and after inspecting its outcome. Do not replay an entire example after a failure.

## Embedded ownership, storage and shutdown

`dataDirectory` is private controller state, with an exclusive local process lock
and persisted owner, pool and configuration identity. A crash-stale lock is never
stolen automatically; follow the [controller recovery runbook](standalone.md)
after proving the prior process is gone. One directory cannot be reopened with a
different owner/provider/storage namespace/image allowlist. Credentials can rotate
without changing identity; credential values are excluded from the identity record.

With `storage: { kind: "local" }` (the default), checkpoint objects are in
`<dataDirectory>/objects/` on the machine running this script, **not Boat**.
`dataDirectory: "./.jetski"` resolves against the script process's working
directory, not the source file's folder. SQLite metadata lives alongside objects
at `.jetski/state.sqlite`. Boat holds live workload files and a disposable cache;
see [where data lives](storage-locations.md) for the full layout. S3/R2 stores objects remotely, **not SQLite metadata**. Back up state as well
as objects for control-plane disk-loss recovery. Remote storage still requires its
adapter consistency qualification; changing an endpoint does not establish it.

`close()` stops scheduling, waits for in-flight effects and durably stops known
assignments, then retires only released idle hosts belonging to this controller's
owner. It does not wait through warm retention. Unsettled operations, uncertain
saves or retirement acknowledgements produce an error and retain recovery state;
it never forces deletion of an active source. Provider ownership rules still
apply: SSH retirement releases adoption, never powers off an operator's machine.
Retained checkpoints/output are not erased on close. Report both work and cleanup
errors in application error handling; `runSandbox` aggregates them automatically.

Keep one controller per data directory and state namespace. An injected shared
state backend needs operator-provided single-controller coordination across
machines/directories; the local lock is not a distributed lease. Independently scheduling that same core
from another process or gateway is unsupported. The advanced `.manager` is a
trusted operator escape hatch and requires coordinated lifecycle access.

## Replaceable components and advanced examples

The Node factory accepts Boat, adopted SSH, or custom host provider/transport
pairs. Storage can be local, S3-compatible, or a custom `CheckpointStore`.
Transactional state, scheduler, host lifecycle, resources and error reporting are
injectable. Custom adapters declare stable IDs for configuration binding and must
satisfy the existing conformance contracts. These hooks do not bypass publication,
lease fencing or owner scope. Credentials remain outside workloads.

The SDK/core imports remain portable; Node/database/host dependencies live behind
the explicit `/node` entry point. The factory dynamically loads selected cloud or
SSH adapters. No additional standalone service is required to embed it.

`sandbox.raw()` exposes owner-scoped command, file, terminal, port and memory APIs
with explicit IDs/cursors. `jetski.client` in HTTP mode provides the full existing
SDK; embedded `jetski.api` provides direct owner-scoped contracts, with
`jetski.manager` for operator integration. Existing terminal/forwarding and gateway
modules remain available through their explicit package exports. PTYs, previews,
TCP tunnels and memory checkpoints retain their capability, authentication and
network-policy requirements. A port permission is not a gateway, and filesystem
`resume()` never silently substitutes for a requested memory restore.
