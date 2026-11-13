# Failure observation and recovery

`waitForOperation()` is included in `@firtoz/jetski@0.2.1`;
[compatibility](compatibility.md) covers the pending command-handle additions.
Jetski distinguishes an operation that is still pending from a failed or uncertain
remote effect. An observation timeout does not cancel work or grant permission
to issue it again. Persist sandbox and operation IDs before admission using
`onOperation`, or supply your own explicit operation IDs.

## Reconnect without replay

After reconnecting, obtain the same sandbox and observe its saved operation ID:

```typescript
const sandbox = await jetski.get(savedSandboxId);
const outcome = await sandbox.waitForOperation(savedOperationId, {
  waitTimeoutMs: 120_000,
});
console.log(outcome.result);
```

This works with embedded Node and standalone-server sessions. The explicit HTTP
SDK equivalent is `client.waitForOperation(sandboxId, operationId, options)`.
Both accept `waitTimeoutMs` and `signal`. They only observe existing work; they do
not call create, resume, execute or reconciliation endpoints. On timeout or
connection loss you can call the observer again with the same IDs. A 404 does not
authorize replay: first establish whether admission happened.

A `succeeded` outcome returns the typed `Operation`, including its result.
`failed` and `uncertain` throw `OperationOutcomeError`, exported from both `/sdk`
and `/node`; `error.operation` preserves the observed identity, phase and outcome.
These phases are not automatically retried. In particular, an uncertain command
may have already performed its external effects.

## Readiness and controller diagnostics

A temporary host-control failure during boxd bootstrap produces an
`unknown` `HostObservation`, keeping the original allocation reserved. Normal
controller reconciliation observes that same allocation again. Explicit ownership,
configuration identity and policy checks still reject. An unconfirmed remote
receipt remains unknown; it is never successful readiness or an excuse to allocate
another host. Boat uses the same
observation contract.

`HostTransportError` from `/core` has `uncertain: true` and optional immutable
`details`: `provider`, a categorical `code`, and numeric `exitCode`/`httpStatus`
when known. Transport wrappers preserve these details. Controller integrations can
inspect them through their error hooks or adapter observations without parsing
message strings or monkey-patching provider clients. Codes classify transport,
remote exit, invalid receipt, output bound, deadline and abort. They are **not**
a retryability policy. Raw stdout/stderr, command arguments and credentials are
excluded from these diagnostics.

## Recover deliberately

An uncertain command/save retains or quarantines its source. `close()` can fail
with recovery state retained; it does not force-delete that source to finish
cleanup. Inspect the sandbox and original operation before deciding the next action.
Use [typed outcome fields](compatibility.md#identify-outcomes), not message parsing
or an assumed retry policy. The [reconnect example](../examples/08-reconnect/) shows
identity persistence and observation before continuing.

If an unfinished save's source is positively absent, explicit SDK/CLI
`recover-missing-source` can select a verified older retained checkpoint:

```sh
jetski recover-missing-source SANDBOX --operation UUID --config /private/recovery.json
```

The JSON must contain the inspected `generation`, exact `lease`, `shutdownId`,
`checkpointId` and `acknowledgement: "unpublished-changes-unavailable"`.
For interrupted placement, use
`recover-missing-placement` with the exact placement identity and its original
checkpoint. These paths require provider-confirmed absence, no competing storage
actors and current authority; a timeout does not prove absence. They leave the
sandbox stopped and the original operation uncertain. A new resume is separate.
Local fault/restart coverage is not universal hosted recovery qualification.
The [OpenAPI recovery schemas](openapi.json) define the complete request types.

[Operations and backups](operations.md) explain controller locks and authority
handover. Privileged forensic archives in [historical evidence](../maintainer/benchmarks/providers.md)
were not automatic checkpoints or successful managed releases. Never erase an
uncertain journal/source or blindly repeat external effects to resolve ambiguity.
