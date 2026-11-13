# Portable-memory measurements

The November 4, 2026 comparison used R2, Boat small hosts, one CPU/512 MiB workload
limits and a changing 64 MiB heap. Six source arms ran three warm cycles each;
compressed-full and incremental low-change arms each had one source-deleted
replacement. Provisioning/priming are outside warm timing. Every mode acknowledges
the same verified filesystem-plus-RAM boundary.

Each query checked heap checksum, random process token, counter and open-file
cursor/content. An independent oracle checked bytes, modes, symlinks/hardlinks
and retained original output. Low change mutates a tiny compressible region;
high change rewrites the whole heap with entropy.

| Profile | Mode             | Resume median | First response | Durable save | New RAM/save |
| ------- | ---------------- | ------------: | -------------: | -----------: | -----------: |
| Low     | raw full         |        3.22 s |         4.29 s |      65.76 s |    64.19 MiB |
| Low     | gzip full        |        3.77 s |         6.17 s |      42.71 s |     0.56 MiB |
| Low     | gzip incremental |        2.62 s |         2.97 s |      12.05 s |     0.07 MiB |
| High    | raw full         |        3.17 s |         4.13 s |      63.65 s |    64.20 MiB |
| High    | gzip full        |        3.81 s |         4.80 s |      61.77 s |    64.07 MiB |
| High    | gzip incremental |        3.26 s |         4.26 s |      61.99 s |    64.12 MiB |

For low change, gzip/reuse cut save time about 82%. R2 body transfer per direction
(including verification) fell from 66.0 MiB raw to 1.9 MiB incremental, and requests
from 428 to 178/cycle. High-change entropy retained roughly 64 MiB/save and little
benefit. Three repeats on one host/arm are limited evidence, not universal ratios.
Native capture still reads full images: this is incremental transfer/retention,
not native dirty-page capture. Retained roots contain complete manifests.

## Replacement and compatibility

| Mode             | Provision + restore + verification | Meaning                                                               |
| ---------------- | ---------------------------------: | --------------------------------------------------------------------- |
| gzip incremental |                            839.7 s | Includes pre-effect permission failure, diagnosis and guarded repair. |
| gzip full        |                            233.3 s | Automatic fixed path; not a repeated latency distribution.            |

Both restored full process/open-file/heap and filesystem state on a physically
different host, then saved again. Before deletion, independent object hashes and
source oracles matched; provider absence preceded placement. Filesystem fallback
was not counted as memory recovery. Recorded filesystem imports took 14.38/15.54 s;
reconstruction 1.33/1.46 s and native effects 0.17/0.12 s. These are nested stages,
not additive whole-operation estimates.

Runtime/image/helper ABI/configuration, kernel and explicit CPU feature compatibility
remain mandatory. RAM images do not preserve an entire host, external sockets or
remote effects. Unacknowledged writes are outside the recovery point. Source/restore
uncertainty retains fences, readers and quarantine rather than repeating effects.

## Evidence limits and accounting

A response-bound mismatch rejected one export before dispatch; ordinary endpoint
bounds were retained. An oracle initially ran before open-file initialization;
that affected sample's request totals include disclosed repair traffic. A target
outer assignment parent required root-owned traversal policy, without changing
persistent root bytes/modes. The incremental replacement includes that guarded
repair; compressed-full tests the automatic fix. Nine warm cycles used the
response-bound fix and nine the parent-handoff fix; codec/storage/warm paths were
unchanged. Failure timings are not relabelled as clean successes.

Thirty additional synthetic local samples isolated codec/reconstruction without
network or a native process. Their compressed low-change ratios are not substituted
for hosted latency. Body counters exclude TLS/headers/image pulls; attempted
uploads can be upper bounds. VM CPU/cgroup samples include different scopes and
are not complete memory-footprint estimates.

Eight hosts were confirmed absent. Observed physical time was 1.164 host-hours;
provider-weighted usage was 2093 seconds, $0.02093 included compute value plus at
most $0.00000796 unsampled tail. Starts and observed wallet debit were $0 under
that account's included allowances, not a promise of free compute. Retained
filesystem/RAM objects totaled 1.518 GB (RAM 1.079 GB); storage/request costs are
separate and history remains retained.

[Application setup](../../docs/portable-memory.md) · [Format authority](../memory-format.md).
