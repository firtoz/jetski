# Failure observation and recovery

These convenience APIs are source previews, not part of npm 0.1.1.
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

## Deliberate safety boundaries

Known runtime compatibility defects use shared implementations: filtered tc/BPF
when the nftables hook is unsupported; terminal signal compatibility when its
ioctl is unsupported; authenticated command-tree cleanup on private-input EOF.
None silently disables networking policy, changes runtime, or signals a reused
numeric PID.

A genuinely uncertain command/save still retains or quarantines its source.
`close()` can fail with recovery state retained; it never force-deletes that source
just to complete cleanup. Inspect the existing operation and host state before an
operator chooses a recovery action. The benchmark's independent emergency archives
were privileged forensic recovery, **not** an automatic public checkpoint or a
successful release. This API does not turn an unclassified provider response into
a known-safe outcome, and does not add automatic deletion of quarantined data.

The [hosted parity report](provider-parity-benchmarks.md) preserves original
failures and measurements. The observation/diagnostic follow-up has local API and
adapter regression coverage; it does not claim another hosted benchmark pass.
