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

## Experimental checkpoint upload staging

This opt-in follow-up is available in source after 0.2.0; it is not in npm 0.2.0.

The Boat transport can opt into `checkpointUploadConcurrency: 2` together with
`archiveWrites: true`. On hosts advertising two fixed temporary import paths,
the controller overlaps at most two bounded binary uploads. Durable commits stay
strictly ordered and each acknowledgement must match the checkpoint identity,
extent and expected cursor. Upload completion alone never advances that cursor.
A restart observes the durable host cursor and can upload uncommitted parts again.
Outstanding uploads settle before temporary-path cleanup or reader release.

This is an opt-in candidate, not a measured speedup or a new default. Older hosts
without the two-path capability keep the serial import path. Other transport
adapters can provide the optional staged-import contract independently; they must
retain verification, fencing and ordered durable acknowledgements.

A controlled, single-host R2 comparison restored the same 151-entry fixture
(165,926,093 archive bytes) into four distinct sandbox identities, ordered serial,
staged, staged, serial. Serial took 31.529/34.417 seconds; staging took
33.221/30.936 seconds. All four filesystem byte/mode/link digests matched.
The average difference was 2.7%, with overlapping results: insufficient evidence
to change the default. Verified chunk commits took roughly 7–9 seconds and durable
extract/flush roughly 11 seconds on that host. Those nested spans must not simply
be added to end-to-end timings. Two samples per mode on one host do not establish
a universal speedup, and host disk performance materially affects these results.

## Choose a smaller compatible image

Image transfer and rootfs preparation can dominate cold setup. A pinned Node slim
image had 81 MB of compressed registry layers versus 410 MB for the full image,
but omitted Git and SSH. Two functional probes booted successfully; neither was
a compatible replacement for a workload needing those tools.

A purpose-built slim image with Git, OpenSSH client and CA certificates produced
a 122 MB compressed OCI archive. Node/Git/SSH commands and canonical manifest
import passed; the exported artifact was SHA-256 verified before source retirement.
This is an image-build result, **not** a qualified cold-start or durable-recovery
result for that custom image. Operators must publish or durably preload their
approved digest before using it, and keep that image available for replacement
hosts. Filesystem checkpoints do not make an unavailable base image recoverable.

Use the smallest image that passes the actual workload and restore checks.
Always compare the same runtime, storage adapter, durability boundary and fixture;
a faster host is not proof of a faster transfer implementation.
