# API and release compatibility

The published package is `@firtoz/jetski@0.3.0`. Its embedded `runSandbox()` and
`openJetski()` helpers, service facade, files and checkpoints support the first
examples. This checkout also contains pending minor-release APIs: command handles,
shared terminal helpers, preview wrappers, intent discovery, resolved diagnostics,
neutral provider factories and the dedicated-machine seam. Use their packed
artifact for source review or wait for the normal release before installing those
APIs from npm. [Release notes](../CHANGELOG.md) identify published behavior.

## Import the layer you use

| Export               | Role                                                             |
| -------------------- | ---------------------------------------------------------------- |
| `/node`              | Embedded Node controller; Node types/runtime required.           |
| `/sdk`               | Portable HTTP client/facade for an independent service.          |
| `/core` and adapters | Platform integration with injected state, scheduling and policy. |

No existing public import is removed. `NodeHostAdapters` and
`NodeHostFactoryContext` remain aliases to neutral factory contracts.
`boxdHostFactory` remains assignable to `NodeProvider`; Boat composition uses the
same seam. `BoatHostProvider` retains runtime attestation, while
`BoatMachineProvider` deliberately exposes physical lifecycle only.

`SandboxOperation.kind` includes terminal/preview intents; exhaustive callbacks
must handle them when using those helpers. Explicit stale/capability HTTP
rejections use 409 and a bounded machine-readable code; other errors retain their
status behavior. Runtime defaults, ownership, checkpoint compatibility and the
versioned execution/transport protocols are unchanged.

## Identify outcomes

| Observation                                              | Typed evidence                                                                                                                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Observation timeout / abort                              | `DOMException.name` is `TimeoutError` / `AbortError` for standard signals; a caller can supply a custom abort reason. Mutating/wait helpers retain this in `JetskiOperationError.cause`. |
| Failed/uncertain lifecycle operation                     | `OperationOutcomeError.operation` retains its phase, result, error and identity; facade mutations wrap it in `JetskiOperationError`.                                                     |
| Quarantined failed/uncertain save                        | `QuarantinedSaveError` retains both the operation and confirmed sandbox quarantine; source is retained. If inspection fails, the original typed operation outcome remains authoritative. |
| Nonzero command exit                                     | `JetskiCommandError.result` contains exit code and bounded bytes; use `check: false` to handle it explicitly.                                                                            |
| Cancelled/uncertain/non-exit command outcome             | `CommandOutcomeError.outcome`, sandbox and command IDs; never authorization to replay.                                                                                                   |
| Stale lease/generation admission                         | `JetskiContractError.code === "stale-generation"`; HTTP `JetskiHttpError.code` carries the same classification.                                                                          |
| Explicit unsupported memory/lease/native-idle capability | `JetskiContractError.code === "unsupported-capability"`, also carried over HTTP.                                                                                                         |
| Unresolved embedded shutdown                             | `JetskiCleanupError.code === "cleanup-unresolved"`, with all constituent errors and recovery directory.                                                                                  |

These classifications cover explicit controller contract rejections, not every
legacy adapter/host error. Other HTTP failures retain status; diagnostics and
provider errors are not exposed as remote messages. Never infer a fallback/retry
permission from a status/code. Quarantine is a confirmed state, not a guessed
interpretation of every transport failure. Read the current sandbox and operation
when classifying legacy failures. `waitForOperation()` observes without mutation.

## TypeScript consumers

Use strict NodeNext resolution for Node applications and strict Bundler resolution
with Web API libraries for portable Worker clients. `/core` and `/sdk` require no
Node type library. Optional provider/native-R2 composition has its own documented
Node-compatibility requirements; portable client support does not qualify those
adapters for every Worker platform.

The [packaged consumer fixtures](../test/consumers/) use public declarations,
`skipLibCheck: false`, and no source aliases or unpublished types. Maintainers can
run the [independent package check](../maintainer/testing.md). For upgrades and
format rollback, follow [the upgrade guide](releases.md).
