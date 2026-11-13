# Configure lifecycle and transfer policy

Use these options when the default resource/reuse profile does not fit your
workload. Standalone configuration and `ManagerOptions` share the core policy;
`NodeOptions` exposes the supported embedded subset. Check their public types
rather than assuming every internal option is a high-level field.

## Resources and maintenance

`workloadResources` defaults to 1 CPU/512 MiB. Integer bounds are 1–64 CPUs and
128–65536 MiB; select a provider shape with sufficient capacity. Limits persist
at sandbox creation, including copies; later configuration changes apply to new
sandboxes. Workload API callers cannot override operator policy.

`automaticCollection` defaults to false. Enable only after storage consistency
and backup/recovery qualification. Reconciliation plus `maintain(owner)` schedules
collection for released stopped/deleted sandboxes. First/daily passes wait 24 hours;
failed attempts retain their identity for retry. Core reachability, generation,
actor exclusion and grace still apply. Maintenance never expires acknowledged
history. [Scheduler contract](embedded-platforms.md#scheduler-contract).

## Lease and idle reuse

`hostLifecycle` accepts immutable `lifetimeMs`, `drainMs` and `idle` policy. Defaults
are one-hour lifetime, five-minute drain and ten-minute fixed idle retention.
An eight-hour lease uses `lifetimeMs: 28800000`, subject to provider capability
and accepted expiry. Existing slots retain their original deadlines/policy.
Commands must fit their timeout and drain interval before provider expiry; this
is not a promise that an arbitrarily large checkpoint can finish in time.

Fixed idle: `{ mode: "fixed", timeoutMs: 600000 }`. Adaptive idle can use:

```json
{
  "mode": "adaptive",
  "minMs": 120000,
  "maxMs": 3600000,
  "fallbackMs": 600000,
  "maxIdleSpendMicros": 18000,
  "currency": "USD"
}
```

Budgets use integer millionths of the declared currency, per idle decision. Quotes
are bounded and cached; stale/error/currency-mismatch cases use the configured
fallback without blocking lifecycle work. An admitted idle deadline is not silently
extended by later pricing. Boat supplies size-adjusted USD quotes; boxd needs its
explicit pricing/disk estimate and account currency. No implicit FX conversion
or account spending guarantee exists. Warm minimum remains zero.

Optional provider-native idle sleep is separate from workload RAM checkpoints.
It requires a released, verified, idle host with no queued demand; transitions
retain durable identities and fence placement until observed. Unsupported providers
refuse it. The allocation deadline still applies while asleep.

## Transfer settings

| Option                                | Consequence                                                                                                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkpointPackBytes`                 | 0 keeps one object per member; a positive bound up to 8 MiB packs immutable members, trading request count against retained storage.                                         |
| `checkpointFrameBytes`                | Explicit 256 KiB/512 KiB/1 MiB capture geometry; smaller members can reduce changed bytes. Large captures grow within bounded metadata limits; old archives remain readable. |
| `inlineCommandOutputBytes`            | 0 disables; up to 8192 stores tiny verified complete output in metadata. Rollback requires an output-format-2-capable reader.                                                |
| `eagerCheckpointCapture`              | Optional combined quiesce/capture saves a control call but may lose overlap with output retention; publication/cleanup gates are unchanged.                                  |
| Boat `archiveReads` / `archiveWrites` | Opt-in scoped binary bindings; fixed supervisor paths, full checks and durable cursor acknowledgements remain mandatory.                                                     |
| `checkpointUploadConcurrency: 2`      | Optional two-slot Boat upload staging with `archiveWrites`; commits remain ordered and all uploads drain before cleanup. Serial remains default.                             |

Save/import journals retain their admitted geometry and immutable identities across
settings changes and restart. Honor negotiated host chunk limits. Upload completion
alone does not acknowledge durable progress. A verified host-local cache accelerates
restore but never replaces the published store; misses use checked staging and
source I/O uncertainty remains failure.

[Performance recommendations](performance-tuning.md) explain when to tune.
[Stage diagnostics](stage-timings.md) measure the path without authorizing release
or replay. [Storage contracts](storage.md) apply to every adapter.
