# Save and restore process memory

Use portable gVisor checkpoints when restarting an application from files would
lose valuable process state or repeat expensive initialization. They publish RAM
and its exact filesystem checkpoint into durable storage, allowing compatible
replacement hosts to continue the process. Podman remains the default;
[configure compatible gVisor hosts](gvisor-runtime.md) first.

## Publish a recovery point

Resolve commands, uploads and interactive streams, then request explicit portable
capture on a compatible assigned sandbox:

```ts
const checkpoint = await sandbox.suspend({
  portable: { codec: "gzip", chunkBytes: 1048576, reuse: true },
});
await sandbox.pin(checkpoint.id, "application-state");
await sandbox.resumeMemory();
```

`gzip` with reuse suits compressible memory with small changes; identity encoding
can avoid compression work for other data. Reuse reduces transfer but capture and
verification still cover complete native image files. Each recovery point has a
complete manifest rather than an unbounded chain of historical patches.

Without `portable` options, `suspend()` seals a local memory image and retains its
exclusive source host. That local image alone cannot survive physical source loss.
Observe each stable operation to completion; unknown native effects retain their
fence/source and must not be replayed.

Explicit SDK calls are `suspend(sandboxId, operationId, portableOptions)` and
`resumeMemory(sandboxId, operationId)`. CLI: `suspend ID --operation UUID
--memory-codec gzip`, optionally `--memory-chunk-bytes N` or `--no-memory-reuse`,
then observe before `resume-memory`.

## Create an independent copy

`fromCheckpoint({ sourceSandboxId, checkpointId, content: "memory" })` copies a
retained same-owner RAM/filesystem graph into a distinct stopped sandbox. Call
`resumeMemory()` separately on the target. Source and target history remain
independent. Ensure enough host capacity: a suspended source can retain its
assignment. The [browser fork demo](../examples/07-memory-fork/) shows complete
configuration and independent file/process state.

## Respect the recovery boundary

Recovery requires compatible runtime archive, approved image, helper ABI,
configuration, kernel and explicit CPU feature baseline. Every encoded/decoded
object and reconstructed file must verify before native execution. Missing or
corrupt memory is never executed. A known pre-effect filesystem fallback reports
process-state loss; the convenience `resumeMemory()` rejects it as RAM continuation.
Uncertain native effects remain quarantined. Ordinary `resume()` restores files
and never claims memory continuity.

External sockets are not portable process state: disconnect and reconnect them.
Checkpointing does not make external side effects exactly once. RAM images can
contain application secrets; protect objects, metadata and backups accordingly.
Remote objects do not back up controller metadata. Preserve both and keep the
approved base image available for replacement hosts.

[Measured tradeoffs and recovery limits](../maintainer/benchmarks/memory.md) ·
[Recovery guide](failure-recovery.md) ·
[Format/authority internals](../maintainer/memory-format.md).
