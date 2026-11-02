# Hosted performance qualification

## November 1, 2026: default configurations

Twenty alternating warm trials completed on two Boat small hosts: ten per
implementation, one physical host per arm. Each trial changed a deterministic
64 MiB fixture, saved to isolated R2 storage, released the assignment, resumed a
fresh writable assignment and checked an independent filesystem oracle. All twenty
checks passed. Both hosts were retired with provider absence confirmed.

This is **not an equal-resource performance qualification**. The reference runtime
used two CPUs and 2 GiB per workload; Jetski used its defaults of one CPU and
512 MiB. The machine class and digest-pinned Node image were the same. The reference
used its existing dispatcher and framed R2 bridge; Jetski used the standalone
manager, SQLite and S3-compatible R2 adapter. Application and model latency were
excluded. Cold setup, initial priming and final release were outside warm timings.

| Median per warm trial                           | Reference |     Jetski |
| ----------------------------------------------- | --------: | ---------: |
| Work, save, resume and independent verification |   7.751 s |   31.681 s |
| Durable save and release                        |   4.966 s |   27.918 s |
| Resume readiness                                |   1.516 s |    1.792 s |
| Object payload uploaded                         |  1.032 MB |   4.178 MB |
| Object payload downloaded                       |  0.005 MB | 201.336 MB |
| Storage requests                                |        18 |         63 |
| Provider API requests                           |        16 |         44 |

Bytes use decimal MB and exclude HTTP overhead. Provider counts exclude data
streams accessed through file-transfer capabilities. Host lifetimes include setup,
controller work and waiting between alternating trials; they are not isolated
cold-start measurements. Two harness failures before priming were preserved and
excluded from the warm timings: a missing budget-journal import, and a bundled
script filename that activated an unintended CLI entry point. Recovery reused the
original host and retained the failed fixture.

The read amplification is a concrete regression to address before release.
`S3CheckpointStore.head` currently reads and hashes complete objects. Repeated
publication checks therefore reread unchanged frame bodies. Any optimization must
preserve verified publication, corruption detection, immutable object identities
and safe collection. Equal-resource repetition and failure/recovery tests remain
required; these results do not establish a Jetski speedup.

## Equal workload limits and conditional reads

A second twenty-trial run used two CPUs and 2 GiB per container on both arms,
with live cgroup limits checked before priming. The same small host class,
digest-pinned image, frozen fixture and alternating workload order were used.
All twenty independent recovery checks passed; two hosts were retired and a
subsequent provider inventory showed zero active hosts. The candidate was
`0080663`, including conditional object verification.

| Median per warm trial               | Reference |   Jetski |
| ----------------------------------- | --------: | -------: |
| Work, save, resume and verification |  17.243 s | 30.892 s |
| Durable save and release            |   7.659 s | 26.966 s |
| Resume readiness                    |   4.738 s |  2.325 s |
| Payload uploaded                    |  1.032 MB | 4.178 MB |
| Payload downloaded                  |  0.005 MB | 4.178 MB |
| Storage requests                    |        18 |       63 |
| Provider API requests               |        16 |       44 |

Conditional verification removed most repeated object-body downloads compared
with the first run, but did not establish competitive save latency. Different
frame sizes and transport round trips remain measured limitations. The reference
was slower than in the first run, so comparisons across runs cannot isolate the
optimization's latency effect. Cold setup and initial priming remain outside these
warm timings. This implementation does not promise universal speedups.


## Follow-on checkpoint optimization screens

Each row below is a separate five-trial-per-arm screen on a fresh host pair,
using the same frozen reference, 64 MiB fixture, approved image, two CPUs, 2 GiB
and durable-save/fresh-assignment recovery boundary. All completed trials passed
independent filesystem checks. **None is a replicated ten-versus-ten result, and
none meets the speed target.** Do not pool different candidates or controllers.

| Candidate and composition                          | Save: reference / candidate | Complete cycle: reference / candidate | Storage calls: reference / candidate |
| -------------------------------------------------- | --------------------------: | ------------------------------------: | -----------------------------------: |
| `98fe0ad`, Node/S3, individual 1 MiB objects       |            5.704 / 29.405 s |                      9.469 / 32.254 s |                             18 / 207 |
| `45b27a5`, Node/S3, physical packs                 |            4.389 / 17.517 s |                      6.510 / 21.184 s |                              18 / 40 |
| `083daad`, Node/S3, signal-aware idle              |             3.379 / 5.936 s |                       5.208 / 8.501 s |                              18 / 40 |
| `083daad`, embedded native R2 adapter              |             4.151 / 5.166 s |                       6.917 / 8.276 s |                              18 / 40 |
| `b691ba2`, embedded native R2, adaptive gzip       |             3.667 / 4.656 s |                       6.080 / 7.894 s |                              18 / 40 |
| `8c488fa`, embedded native R2, fewer control calls |             3.007 / 4.052 s |                       4.820 / 7.198 s |                              18 / 40 |

The reference uses Node orchestration with a Cloudflare native-R2 retention
worker. The embedded candidate runs core coordination and its adapter in a
Cloudflare Durable Object. These are different control-plane compositions;
changes between screens do not isolate transport costs. The `083daad` native candidate's
median readiness was 1.607 s versus 1.793 s; maximum saves were 5.413 s versus
5.213 s. Five observations per arm cannot establish stable tail estimates.
All screens uploaded approximately 1.04 MB per warm trial.

A second host pair for `98fe0ad` failed at the five-minute candidate creation
deadline before timed work, leaving a quarantined `creating` receipt. No workload
commands were admitted. Its evidence and checkpoints are preserved. All fourteen
hosts across the screens and failed setup were retired; subsequent inventory
reported zero active hosts. Embedded controller state was backed up before
removing its temporary controller. These counts are physical starts, not logical
sessions, and do not establish invoice attribution.

Passive persisted-phase observations isolated two quiesce intervals of 10.350
and 10.364 s in the packed screen. An idle PID 1 sleep consumed the stop grace.
The signal-aware candidate retains that grace, command settlement and observed
stopped-state checks; it also batches independent output retention and drains
failed siblings before allowing cleanup. Capture and control round trips remain
optimization targets. Later candidates still require the complete replicated
comparison, large cold/replacement recovery and downstream qualification.


Two further diagnostic hosts are excluded from the comparison table. One exposed
a priming failure: negotiated source ranges reached the controller intact, but a
shared decoder still enforced the ordinary output limit. The retained save journal
recovered on that same host after the bound was fixed; three exact cycles passed.
Both diagnostic hosts were retired. Four later attempts failed before timed
trials, bringing the retired follow-on total to twenty-three starts. Three
quarantined an empty runtime during initial creation; one stopped before reference
setup. A later runtime stack located image ownership remapping; its child wrote
1.13 GB and waited on filesystem journal commits before finishing. This refines
the earlier API/CLI contention hypothesis: shared-engine control alone did not
resolve startup. The harness used native overlay; the actual client selects FUSE.
The next frozen comparison uses that candidate setting, independently verifies its
mount program and reports the reference's differing native-overlay policy. Failed
setups remain separate from timing results; they are not successful comparisons.

The resulting FUSE screen completed five trials per arm with exact oracles and
owned cleanup. Median save was6.815 versus3.670 s, warm resume7.363 versus1.070 s,
and complete cycle17.649 versus5.685 s. Median changed upload fell to259,410
bytes versus1,042,257, but reduced bytes did not establish speed parity. Both
hosts were retired, bringing the follow-on total to twenty-five starts. A second
FUSE pair was not run because the measured gap was clear; the full replicated
acceptance comparison remains open.

Local encoding screens informed later candidates: adaptive gzip reduced a16 MiB
binary encode from307 to24 ms, and a source-like mix from180 to164 ms with0.36%
more encoded bytes. With physical packing, a64 MiB fixture's4 KiB edit changed
259,147 encoded bytes at256 KiB geometry versus1,045,819 at1 MiB. Both initial
archives used nine8 MiB packs; capture measured349 versus377 ms. These local
measurements do not establish end-to-end speed.
