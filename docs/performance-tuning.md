# Performance defaults and tuning

Safe lifecycle and integrity improvements are automatic. Resource consumption,
paid warm capacity and provider-dependent fast paths remain explicit choices.

| Setting or behavior                 | General default                            | When to change it                                                                                                                         |
| ----------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Host preparation                    | No minimum warm pool; demand-created hosts | Call embedded `prepareHosts` before expected same-owner demand. Warmup and idle time cost compute.                                        |
| Host capacity / startup concurrency | One host per owner / one startup           | Increase both for parallel independent sandboxes. One host still has only one active assignment.                                          |
| Copy work per scheduler turn        | 16 streamed objects                        | `checkpointCopyBatchObjects: 256` suits a dedicated controller copying a few large roots; bigger batches delay other reconciliation work. |
| Memory restore writes               | One independent object at a time           | `memoryRestoreConcurrency: 2` or `4` can overlap control latency. Shared binary import sinks and older journals remain serial.            |
| Boat binary archive downloads       | Off                                        | Set `provider.archiveReads: true` on a qualified Boat account. Hashes and full publication checks remain mandatory.                       |
| Memory chunk size                   | Explicit portable-checkpoint option        | 1 MiB favors finer incremental reuse; the full-browser fork uses 4 MiB to reduce object/request overhead.                                 |
| Idle retention / lifetime           | Existing bounded lifecycle policy          | Tune for measured return patterns and provider pricing; do not leave hosts warm indefinitely to hide cold starts.                         |

Acknowledged file-upload initialization, immutable per-controller bootstrap assets,
per-object progress journals, multi-wave preparation checks and pinned local-image
cache reuse are automatic. They remove redundant work without relaxing integrity
or replay rules. Copy default 16 remains bounded and configurable down to 1.

On supported Linux >= 5.8 hosts, image preparation uses a checked filesystem flush
with its descriptor opened before copying, after the same bounded tree validation.
Older/unsupported hosts use per-file fsync. A failed flush or unexpected filesystem
boundary rejects preparation; it never falls back in a way that hides write errors.
This host-side behavior does not flush or reconfigure the controller's desktop.

## Embedded examples

[05-warm-pool](../examples/05-warm-pool/) shows explicit preparation followed by
ordinary sessions. Reuse a persisted operation ID to observe the same preparation;
a completed ID does not replenish hosts after consumption or promise permanent
availability. `close()` retires released owned hosts after durable publication.
See [API/recovery semantics](simple-api.md#prepare-hosts-before-demand).

[07-memory-fork](../examples/07-memory-fork/) selects a measured fast profile:
three prepared hosts, startup concurrency 3, copy batch 256, 4 MiB RAM chunks,
restore concurrency 4 and Boat binary reads. Those choices are demo/operator
configuration, not a global switch for every workload or provider.

Only explicitly unsupported read ranges can use the same fenced control-read
fallback. Server/authentication/corruption errors remain failures. Restarted or
uncertain object writes observe the host's durable cursor; native execution is
never blindly replayed. More concurrency uses additional bounded buffers and
provider requests; it cannot bypass owner limits or checkpoint verification.

The [measured comparison](chromium-transfer-performance.md) includes cold warmup,
failed-trial exclusions, compute bounds and the diminishing-returns decision.
Its local storage results are not a new R2 or cross-provider qualification.
