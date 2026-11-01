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
