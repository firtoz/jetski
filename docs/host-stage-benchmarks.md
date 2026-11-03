# Instrumented host-stage comparison

## Recommendation

**Keep Python as the default and combined quiesce/capture disabled.** The candidate
removed one specific control round trip per save, but did not demonstrate a
repeatable end-to-end speedup. The instrumentation is useful; the buffering and
batching changes remain experimental, not a reason to switch a client backend.
Do not skip filesystem sync or publication verification to improve these numbers.

Measured November 3, 2026. Instrumentation-only baseline `7fcba34`; candidate
`ee37956`. Both have the same timing hooks. Candidate adds a bounded 1 MiB Rust
extraction buffer and enables opt-in combined quiesce/capture for both backends.
[Configuration and timing semantics](stage-timings.md).

## End-to-end results

Ten valid cycles per column, two reversed four-arm groups. Means in seconds;
the rows add up. “Work” includes command dispatch/output and the mutation workload,
not just CPU inside the command.

| Component                      | Python baseline | Python candidate | Rust baseline | Rust candidate |
| ------------------------------ | --------------: | ---------------: | ------------: | -------------: |
| Warm resume                    |          2.60 s |           8.85 s |        2.14 s |        16.68 s |
| Mutation command               |          0.78 s |           2.44 s |        0.43 s |         2.54 s |
| Independent oracle and harness |          0.71 s |           2.17 s |        0.38 s |         1.03 s |
| Verified save/release          |          6.06 s |           8.61 s |        5.72 s |         9.36 s |
| **Whole cycle mean**           |         10.15 s |          22.07 s |        8.67 s |        29.60 s |
| **Whole cycle median**         |          9.21 s |          23.27 s |        8.50 s |        14.32 s |

These are negative end-to-end results for the candidate, not proof of a language
penalty or of batching as the sole cause. Fresh hosts and changed ordering were
not independently crossed on the same physical machine. General host/runtime
slowdowns, storage pressure and ordering effects cannot be separated by this run.
All slow successful samples remain in the results; none were dropped as outliers.

| Group | Python baseline / candidate mean cycle | Rust baseline / candidate mean cycle |
| ----- | -------------------------------------: | -----------------------------------: |
| 1     |                       8.38 s / 16.77 s |                      8.46 s / 8.04 s |
| 2     |                      11.92 s / 27.37 s |                     8.87 s / 51.16 s |

The second candidate group used the required fresh replacement hosts before timing.
Rust's replacement/bootstrap/restore/verification took 456.53 s; Python's took
142.26 s. These include provisioning, bootstrap, transfer and independent checks,
not pure restore latency. Eight initial readiness observations ranged from
60.31 to 103.14 s. The additional replacement stage makes physical-host variability
particularly important; it was required recovery evidence, not an extra timing win.

## Where the time went

Per-cycle **mean observed stage durations**, in seconds. Host restore spans contain
extraction and sync/publication; control spans contain host work. These rows are
nested diagnostics and must not all be added to the whole-cycle table.

| Stage                                             | Python baseline | Python candidate | Rust baseline | Rust candidate |
| ------------------------------------------------- | --------------: | ---------------: | ------------: | -------------: |
| Resume host readiness/probe call                  |          0.65 s |           1.31 s |        0.45 s |         6.43 s |
| Archive decode/validation/extraction              |          0.16 s |           0.48 s |        0.07 s |         2.98 s |
| Filesystem metadata, sync and staging publication |          1.27 s |           2.37 s |        1.26 s |         2.63 s |
| Container creation                                |          0.19 s |           2.24 s |        0.12 s |         3.28 s |
| Archive capture/hash/compression                  |          1.66 s |           1.18 s |        1.67 s |         2.92 s |
| Transfer and durable publication                  |          2.62 s |           2.89 s |        2.76 s |         2.82 s |
| Final remote verification                         |          0.55 s |           0.50 s |        0.50 s |         0.47 s |
| Host finalization/cache/cleanup call              |          0.46 s |           1.79 s |        0.25 s |         1.64 s |

On the baseline hosts, filesystem sync/publication took about 1.25–1.27 s, while
extraction took 0.07–0.16 s. Buffering therefore targets a small portion of the
healthy warm-resume path. In the first Rust group, extraction averaged 69.70 ms
baseline versus 56.79 ms candidate, with about 1.25 s of sync in both. That small
local-stage difference did not generalize: extraction averaged 5.90 s on the slow
candidate replacement host, alongside slow probes, creation and finalization.
The full sample does not establish a repeatable buffering speedup.

Save transfer/publication remained around 2.6–2.9 s across variants, plus roughly
0.5 s of final verification. Batching removes the separate capture command, but
can remove overlap between capture and retained-output uploads. Both paths still
require stopped execution, settled output/input, complete remote verification
and verified publication before destructive cleanup. Neither a ready receipt nor
faster diagnostics can bypass fencing or those checks.

## Requests, bytes and sampled resources

Totals across ten valid cycles per column:

| Metric                                          | Python baseline | Python candidate | Rust baseline | Rust candidate |
| ----------------------------------------------- | --------------: | ---------------: | ------------: | -------------: |
| Authenticated provider API requests             |             121 |              160 |           108 |            156 |
| Physical S3 HTTP requests                       |             320 |              320 |           320 |            320 |
| New storage payload uploaded, bytes             |       3,849,238 |        3,603,028 |     3,609,328 |      3,609,328 |
| Explicit checkpoint restore payload read, bytes |               0 |                0 |             0 |              0 |
| Synchronous control user CPU, seconds           |           12.84 |             9.62 |          5.32 |           6.87 |
| Synchronous control system CPU, seconds         |            6.20 |             9.95 |          2.68 |          54.31 |
| Peak observed control/descendant RSS, KiB       |        36736.00 |         36992.00 |      36608.00 |       38272.00 |

The candidate structurally eliminated twenty separate capture calls across its
twenty cycles. **Total provider requests still rose**, because slow commands
required more observations. R2 requests did not fall: each column used 320.
The extra replacement sample's generation/frame history affects Python-baseline
upload bytes, so that byte difference is not a batching compression win.

Zero explicit restore payload means warm archive reuse, not zero download traffic.
The S3 adapter separately reads every newly uploaded object back before publication;
those internal verification bodies are not in the restore-byte counter. Successful
new uploads imply at least their uploaded byte count in verification readback,
in addition to explicit restore reads. Headers, metadata and total wire bytes are
not measured here. Storage HTTP timings end at headers; core/storage spans cover
body verification and consumption/backpressure. Metering requests are separate.

CPU samples cover synchronous host-control processes and waited descendants,
excluding detached workers, the persistent engine and total VM/workload CPU/RAM.
Call counts differ; these are diagnostic totals, not normalized whole-machine
language efficiency. Equal diagnostics were enabled on all hosted variants.
Local no-op clock/callback measurements were below one microsecond per core call;
Python context/JSON timing into memory was below ten microseconds per call. These
microbenchmarks exclude real stderr, filesystem logging and network transport;
complete instrumentation overhead was not isolated in a separate hosted arm.

## Integrity, real failure and cleanup

Forty valid mutation/save cycles passed independent post-mutation filesystem
comparisons and verified archive publication. Both optimized backends passed exact
source-deleted replacement recovery and retained original command output. Existing
cross-language archive, mode/link, stale-fence and uncertain-execution evidence is
reused; unchanged interactive qualification was not repeated. Local candidate
checks passed 288 TypeScript, 142 Python and 60 Rust tests, build/typecheck/lint and
clippy. Candidate runtime CI passed all eight jobs. Baseline native/unit checks
passed; its unchanged SSH/FUSE browser smoke test timed out on `Browser.getVersion`
twice. Both failures are preserved; unrelated checks were not repeatedly rerun.

R2 returned HTTP 502 during one Python-baseline final verification. Cleanup was
refused and the source remained quarantined. The original save ID was reconciled;
a fresh restore matched the pre-failure oracle exactly, without replaying the
acknowledged mutation. Its failed timing is preserved and excluded, and exactly
one next-generation mutation replaced that affected sample: **41 attempts, 40
valid samples**. Completed rows, original IDs and frozen source/artifacts remained
unchanged. The next generation preserved acknowledged history rather than rolling
files back to manufacture an identical trial. The HTTP failure is a shared storage
dependency event, not evidence that one language avoids outages. Aggregate setup
counters across that controller restart may be lower bounds; valid timed deltas
remain scoped to their intervals.

The experiment used **ten starts**, with both failure reserves unused. All ten
were quoted at $0 under included starts. Provider-reported compute value, including
setup and retained idle, was **$0.04326–$0.04346**
after bounding unsampled deletion tails. Observed wallet balance stayed $52.54;
observed debit was $0, not a claim of free compute or exact invoice attribution.
Sixty bounded read-only metering requests ran outside timed rows. R2 and control-
plane costs are separate. All ten owned hosts returned provider404; active inventory
was empty and the controller exited. Acknowledged checkpoint history was retained.

This finite comparison is complete. There is no production/client cutover or
default backend/batching switch. The useful next targets are durable filesystem
write/sync volume, readiness/runtime probe overhead and storage publication phases;
this run does not justify deleting verification or starting more hosts to chase a win.
