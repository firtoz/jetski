# Filesystem checkpoint measurements

The qualified warm comparison used frozen runtime `62eab00`: ten trials per arm,
two fresh Boat host pairs with reversed order. Both arms used the same approved
image, two CPUs/2 GiB, native overlay and a deterministic 64 MiB fixture. Timings
end at verified publication/readiness and independent filesystem comparison.
All 20 comparisons matched; setup, priming and final cleanup are outside warm rows.

| Warm metric                            | Reference median / sample p95 | Jetski median / sample p95 |
| -------------------------------------- | ----------------------------: | -------------------------: |
| Durable save/release                   |               4.923 / 5.903 s |            2.499 / 3.853 s |
| Resume readiness                       |               2.018 / 3.292 s |            1.104 / 1.836 s |
| Complete work/save/resume/verification |              8.034 / 10.271 s |            4.933 / 6.119 s |
| Payload uploaded                       |                      1.042 MB |                   0.263 MB |
| Payload downloaded                     |                      0.005 MB |                       0 MB |
| Storage / provider API requests        |                       18 / 16 |                  31 / 10.5 |

Save/cycle medians improved on both pairs. Second-pair readiness was nearly tied
(1.054 versus 1.042 s); this is not an every-run or universal speed claim. With ten
observations, sample p95 is the maximum. Bytes exclude HTTP overhead, and provider
counts exclude signed streams. Jetski used Durable Object/native R2 coordination;
the reference used Node/a native-R2 bridge. These compositions differ, so the
comparison cannot isolate the contribution of one optimization. More storage
requests remain a tradeoff despite reduced payload/control traffic.

Jetski used negotiated combined cached resume while retaining claim/import/create
checks and core reader fencing. Smaller independently compressed members, physical
packing and verification remain bounded and compatible with retained archives.
A reference setup failure was repaired on its original host before timing; failed
setup and retained compute are not successful timing samples. All four comparison
hosts were retired.

## Physical replacement

`c6864d4` changed missing-package bootstrap only; warm host/checkpoint assets were
unchanged. Its separate source-deleted comparison restored 436,207,724 logical
bytes in **36.774 s Jetski versus 51.309 s reference**, including independent whole-
filesystem bytes/modes/link checks, retained output and repeated saves. Both hosts
were retired. One pair establishes an observation, not a population median or an
isolated causal effect of package installation.

A separate pinned-client replacement matched 158 entries / 322,845,310 logical
bytes, session files and original output. Checkpoint publication/release and owned
absence were verified. These results establish the tested recovery boundary, not
universal physical replacement or zero-loss guarantees.

## Interpretation

Previous candidate trials did not consistently meet warm parity; their mixed/tail
results and interrupted setup are not pooled into this frozen comparison. The
valid evidence is the matched workload above. Superseded candidate sequences are
in version history. A larger first-save path and other host/network conditions
must be measured separately rather than inferred from warm cache timings.
