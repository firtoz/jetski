# Simple application API

Install `@firtoz/jetski@0.3.0` for the embedded Node controller or server-backed
SDK. Published numbered examples pin that release and run independently with
`npm install`; no Jetski source build or sibling link is required.

## API hierarchy

- `/node`: embedded Node controller (`runSandbox`, `openJetski`).
- `/sdk`: portable clients of an independently running service (`Jetski`, `JetskiClient`).
- `/core` and explicit adapters: advanced platform composition, with injected state,
  scheduler, storage, identity/policy and telemetry. No standalone service required.

[Strict packed consumers and compatibility](compatibility.md) and
[embedded platform composition](embedded-platforms.md) cover supported entry points.

## Lifecycle

| Action                                         | Execution and assignment                                             | Durable history / controller                                                |
| ---------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `writeFile()`                                  | Live files change; execution continues                               | Not a checkpoint                                                            |
| `checkpoint()`                                 | Stops execution, retains assignment by default                       | Verifies/publishes filesystem state                                         |
| `checkpoint({ releaseHost: true })` / `stop()` | Publishes, then releases assignment                                  | Files/output retained; released host may stay warm                          |
| `resume()`                                     | Restores files into a fresh writable workload                        | Does not continue process memory                                            |
| `suspend()` / `resumeMemory()`                 | Explicit RAM/disk capture / proven compatible continuation           | Never silently reports filesystem restore as memory continuation            |
| Embedded `close()`                             | Stops/saves known assignments; retires eligible released owned hosts | Stops controller scheduling; retains history; unresolved cleanup rejects    |
| Detach HTTP client                             | No remote shutdown or cancellation                                   | Independent controller keeps scheduling; facade has no controller `close()` |
| `delete()`                                     | Explicit deletion workflow, including safe shutdown                  | Separate from stop and eventual object GC; pins/grace still apply           |
| GC                                             | No execution shortcut or source deletion on uncertainty              | Complete reachability, explicit retention and minimum 24-hour grace         |
| Timeout / aborted observation                  | Remote work may still run                                            | Reconnect to existing IDs; no automatic replay/cancellation                 |

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
[Compatibility](compatibility.md) identifies additions awaiting release.
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
[Boat](../examples/02-hello-world-boat/), [boxd](../examples/06-boxd/) and [R2](../examples/03-hello-world-r2/)
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
exit codes explicitly. Large/live command output uses `startCommand()` and its cursor-based handle.
Both channels retain at most 16 MiB; reaching that bound can truncate output.
The facade returns retained bytes, not a promise of complete unbounded logs.

## Interactive work

See [release availability](compatibility.md) before using command/terminal helpers:

```ts
const command = await sandbox.startCommand(["sh", "-c", "printf hello"]);
for await (const chunk of command.output("stdout", { offset: savedOffset })) {
  await consume(chunk.bytes);
  await persistCursor(chunk.nextOffset);
}
const result = await command.wait();
```

Persist sandbox/command IDs and separate channel cursors. `sandbox.command(id)`
reattaches without admission. `status()` observes, `wait()` collects bounded output,
and `cancel()` explicitly requests cancellation; its acknowledgement is not a
confirmed exit. Breaking/aborting observation never cancels remote work.

The shared terminal helpers reuse `TerminalAttachment`'s durable input journal.
`exposePort()` grants a generation-bound permission, not a URL. Service previews
need an authenticated configured gateway; TCP forwarding requires explicit local
listener/key setup. [Interactive setup and contracts](interactive-access.md).

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

See the [complete restart/reconnect example](../examples/08-reconnect/).
Embedded `operationIntents({ after, limit })` locates automatically journaled IDs;
these are intentions, not confirmation of admission. `resolvedConfiguration()`
reports absolute controller paths and owner/pool identity without credentials.

An explicit retry of `stop()` on the same handle reuses its ID within the same
generation. Resume advances the generation and the next stop uses a new ID.
For other mutations, reuse the originally recorded ID only with the same input
and after inspecting its outcome. Do not replay an entire example after a failure.

## Embedded ownership and shutdown

Use one authoritative controller per private data directory/state namespace.
Reopen requires the same bound owner/provider/storage/image identity; credentials
can rotate without changing namespace. A crash-stale lock is not stolen
automatically. Follow [controller recovery](operations.md) after proving every old
controller/supervisor has stopped. The local lock is not distributed coordination.

Local objects and SQLite live on the controller, not the workload host or remote
SDK client. Relative paths resolve from the opening process's working directory.
R2/S3 replaces object storage, not metadata. Back up both and keep their identities
matched. [Storage locations](storage-locations.md).

`close()` stops scheduling, waits for in-flight effects, durably stops known
assignments and retires released owned hosts without waiting through idle retention.
Unsettled operations, uncertain saves or retirement replies reject with recovery
state retained; no active source is force-deleted. SSH retirement only releases
adoption. Retained history remains. Preserve both work and cleanup errors;
`runSandbox()` aggregates them automatically.

For injectable providers/state/storage/scheduling and operator access, use
[platform integration](embedded-platforms.md). `sandbox.raw()`, service
`jetski.client`, embedded `jetski.api` and trusted `jetski.manager` retain explicit
advanced contracts. They do not bypass owner, fencing, publication or authorization.

## Prepare hosts before demand

Embedded callers can explicitly prepare idle hosts and their approved images:

```ts
const prepared = await jetski.prepareHosts({
  count: 2,
  operationId: "your-persisted-uuid",
});
const sandbox = await jetski.create(); // consumes a prepared owner-scoped host
```

Set `hostsPerOwner` high enough and optionally `hostStartupConcurrency` to bound
parallel preparation. The default remains zero minimum warm capacity. This is a
one-shot operation, not a pool that replenishes itself. Replaying its ID observes
its recorded result even after the hosts have been consumed or retired; it does
not promise they remain available forever. New requests need new persisted IDs.
Capacity includes active and uncertain hosts; preparation never evicts a workload.

Preparation uses the same approved runtime/image policy and owner isolation as
placement. It expires within 15 minutes or earlier near drain; completed IDs do
not replenish capacity. Timeout does not undo an uncertain allocation. `close()`
cancels undispatched preparation and retires positively released owned hosts,
reporting uncertainty with recovery state retained. This is embedded Node/core
functionality, not an additional HTTP route.

For memory-write concurrency, binary archives and image choices, use
[performance settings](performance-tuning.md).
