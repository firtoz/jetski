# Qualification32 frozen comparison

The frozen `27720c6` comparison completed ten trials per arm on two independent
Boat host pairs, five per arm per pair with reversed order on the second pair.
Image, two CPUs,2 GiB, native overlay,64 MiB fixture and verified durability/
readiness boundaries match the preceding comparison. All20 independent filesystem
checks match; all four hosts have positive provider-absence receipts and both
pairs of temporary controllers are deleted. Setup, priming and final release
are outside timed rows. Source archives and failed historical attempts remain
separate; this is not a cold-recovery qualification.

| Warm metric                            | Reference median / sample p95 | Candidate median / sample p95 |
| -------------------------------------- | ----------------------------: | ----------------------------: |
| Durable save/release                   |              10.369 /16.091 s |               7.196 /11.230 s |
| Resume readiness                       |               4.726 /11.206 s |                4.588 /7.279 s |
| Complete work/save/resume/verification |              19.783 /34.636 s |              16.474 /21.865 s |
| Payload uploaded                       |                      1.042 MB |                      0.263 MB |
| Payload downloaded                     |                      0.005 MB |                          0 MB |
| Storage / provider API requests        |                        18 /16 |                        31 /20 |

These pooled save/cycle medians improve, but **consistent parity is unproven**.
The first pair loses substantially while the second wins; pooled readiness differs
by only138 ms and the median paired readiness ratio is1.003, effectively tied.
Do not interpret host variance as the restore change's isolated effect. With ten
observations per arm, sample p95 is the maximum. API counts exclude signed data
streams; payload counts exclude HTTP overhead. Reference coordination uses Node
and a native-R2 bridge, while the candidate uses a Durable Object and native R2.

| Host pair | Save reference / candidate | Readiness reference / candidate | Cycle reference / candidate |
| --------- | -------------------------: | ------------------------------: | --------------------------: |
| First     |             6.314 /7.843 s |                  2.073 /2.959 s |             8.963 /19.104 s |
| Second    |            13.831 /5.577 s |                  8.287 /5.024 s |            28.761 /14.538 s |

The host restore now hashes/validates while unpacking into private staging,
applies final metadata and syncs primary inodes once, then publishes atomically.
Successful cached import finishes during begin without another control call.
A separate driver correction immediately rechecks authoritative completion after
reconciliation; it no longer always waits250 ms after completion. Both replicas
include that correction, so this comparison cannot isolate its effect from the
runtime change. Earlier measured rows below are preserved without estimated
subtraction. Local screens did not establish a speedup. The pinned downstream workflow and exact larger source-deleted recovery now pass.
A further corrected-observer host pair still loses warm parity; its cold caller
was interrupted and recovered, so it supplies recovery evidence rather than a
clean latency win. An optional combined cache-resume path is under qualification;
see the [active goal](../goals/checkpoint-performance.md).
