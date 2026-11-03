# Longer leases and adaptive idle retention: measured results

Qualification 35 reduced host starts, retained idle compute and remote download
bytes in this trace. Ordinary warm resumes and saves were slower. Keep those
results separate: longer reuse was a resource improvement, not a universal latency
improvement. [Aggregate measurements](benchmarks/host-lifecycle-2026-11-03.json)
retain both outcomes and the per-replica results.

## Matched workload

Two real-clock replicas compared qualification 34 (`c6864d4`) with qualification 35
(`cb20593`). Both requested the same approved image, small Boat machines, two
workload CPUs, 2 GiB RAM, native overlay, S3-compatible R2, 256 KiB capture frames
and 8 MiB packs. The fixture held 64 MiB of physical binary data, 134,217,808 logical
bytes including hardlinks, and eleven entries across both persistent paths.

The comparison controller ran on Node 24 and SQLite using the public S3 adapter
against R2. The separately qualified embedded client uses native R2. These timings
are not direct measurements of its UI path.

Each arm ran 51 sessions 90 seconds apart over 75 minutes, then remained unused
for 25 minutes and returned once from remote storage. Both versions used the same
120-second command budget and 30-second launch allowance. A caller retired an
already-durably-stopped host before dispatch when that work could no longer fit
before its immutable drain deadline. Neither version replayed uncertain commands.

| Result, across two replicas          | One hour / fixed ten-minute idle | Eight hours / adaptive idle |
| ------------------------------------ | -------------------------------: | --------------------------: |
| Successful logical sessions          |                              104 |                         104 |
| Physical host starts                 |                                6 |                           4 |
| Observed allocated host time         |                       194.23 min |                  179.21 min |
| Retention after last busy session    |                         600.70 s |                    120.24 s |
| Median warm resume                   |                           4.13 s |                      5.65 s |
| Median durable save, unchanged data  |                           5.58 s |                      6.51 s |
| Median busy verify/save/resume cycle |                          10.91 s |                     13.72 s |
| Cold rollovers during busy work      |                  92.07 / 70.01 s |                        None |
| Return after 25 unused minutes       |                 190.04 / 97.69 s |           143.57 / 100.70 s |
| Uploaded object payload              |                        134.25 MB |                   134.25 MB |
| Downloaded object payload            |                        268.50 MB |                   134.25 MB |
| Object-storage HTTP requests         |                            2,934 |                       2,916 |
| Runtime provider HTTP requests       |                            1,163 |                       1,336 |

Starts fell **33.3%**, observed host time **7.7%**, last-gap idle retention **80.0%**
and remote payload downloads **50.0%**. Provider control requests increased about
15%; pricing refresh and observation costs are included in the recorded driver
behavior. Benchmark metering added 228 read-only requests outside workload timing. Extra
staging probes and budget/preflight reconciliation are additional control-plane
overhead.

## Cost boundaries

All ten comparison starts were quoted zero start surcharges under the account's
included quota. [Provider per-sandbox usage](https://docs.boat.dev/api/reference/sandboxes/get-sandbox-usage)
reported weighted machine seconds and compute value. For small machines the
multiplier was 0.5; those counters must not be presented as raw physical seconds.

Permanent deletion makes that endpoint return404, so the last successful reading
is a lower bound. Positive observed provider absence bounds the missing tail,
with a one-weighted-second rounding allowance. Across both replicas, compute value
was **$0.05770–$0.05831 before** and **$0.05343–$0.05378 after**: a measured bounded
saving of **$0.00392–$0.00488** for these 104 sessions per policy. Allocation-ack to
absence timing gives a $0.00451 equivalent saving; it is an observation estimate.

The full comparison plus separate embedded-client qualification used twelve hosts,
all retired, and **$0.13511 of included compute credits**. The account wallet debit
was **$0.00**. This is credit conservation rather than an immediate invoice saving.
No snapshot, top-up or extra purchase was made. The separate $10 allowance was
not exhausted.

For sensitivity only, applying one uniform start fee to every physical start gives:

| Hypothetical fee/start | Before: compute equivalent + starts |    After |   Saving |
| ---------------------- | ----------------------------------: | -------: | -------: |
| $0.00                  |                            $0.05827 | $0.05376 | $0.00451 |
| $0.03                  |                            $0.23827 | $0.17376 | $0.06451 |
| $0.05                  |                            $0.35827 | $0.25376 | $0.10451 |
| $0.07                  |                            $0.47827 | $0.33376 | $0.14451 |

These are counterfactual constant-fee cases, not progressive start-window bills
or forecasts for other owners, session lengths or concurrency patterns.

## Reliability and measured limits

All **208** timed restore/verify/save cycles matched independent bytes, modes,
symlinks and hardlinks. An embedded staging client also used one physical host
beyond 61 real minutes, saved durably, observed its source become provider404,
and restored on a different host. All 158 entries and 322,845,310 logical bytes,
saved session files and original acknowledged output matched. Final durable
release, retained checkpoint references, idle application state, owned provider
absence and temporary control-worker cleanup passed.

The trace saves unchanged files; it does not measure changed-chunk uploads or
complete coding-job throughput. Warm medians regressed by about 37% for resume
and 17% for save, and the busy-cycle median by 26%. Much of the resume difference
was concentrated in the second replica (3.40 s versus 7.60 s); the first was
4.52 s versus 4.90 s. This does not establish whether host variability, accumulated
runtime state or lifecycle overhead caused the difference. No extra paid trials
were added to turn that mixed result into a speed claim.

A harness filename guard and a copied-hash preflight failed during setup; their
receipts remain failed. Reviewed generated scratch was repaired on the same four
hosts before timed work. Caller job-headroom handling was added at a proven
fully-durable idle boundary; runtime builds, workload, clock and operation IDs
were preserved. Physical usage includes setup/repair, and the driver restart can
affect caches and control traffic. Two replicas are limited evidence, not a
universal speedup or absolute zero-loss guarantee.

The eight-hour profile is useful when avoiding physical starts and cold
reconstruction matters. Idle minimum, maximum, fallback and spending bounds stay
operator-configurable; the portable default remains one hour and ten minutes.
See [standalone configuration](standalone.md) for the supported policy contract.
