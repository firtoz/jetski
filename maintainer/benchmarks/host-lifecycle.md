# Host lifetime and adaptive idle measurements

Two real-clock replicas compared `c6864d4` (one-hour leases/fixed ten-minute idle)
with `cb20593` (eight-hour leases/adaptive idle). Each arm ran 51 sessions 90 seconds
apart over 75 minutes, then returned after 25 unused minutes: 104 sessions per
policy. [Aggregate/per-replica data](data/host-lifecycle-2026-11-03.json).

Both used small Boat machines, the same pinned image, two workload CPUs/2 GiB,
native overlay, S3-compatible R2, 256 KiB capture members and 8 MiB packs. The
fixture had 64 MiB physical binary data, 134,217,808 logical bytes including
hardlinks, and 11 entries across both persistent paths. Controller: Node/SQLite
with the public S3 adapter, rather than a direct measurement of a client UI.

| Result                               |     Fixed policy | Longer/adaptive policy |
| ------------------------------------ | ---------------: | ---------------------: |
| Successful sessions                  |              104 |                    104 |
| Physical starts                      |                6 |                      4 |
| Observed allocated host time         |       194.23 min |             179.21 min |
| Final busy-gap idle retention        |         600.70 s |               120.24 s |
| Median warm resume                   |           4.13 s |                 5.65 s |
| Median save, unchanged data          |           5.58 s |                 6.51 s |
| Median busy verify/save/resume cycle |          10.91 s |                13.72 s |
| Busy cold rollovers                  |  92.07 / 70.01 s |                   None |
| Return after 25 unused minutes       | 190.04 / 97.69 s |      143.57 / 100.70 s |
| Uploaded payload                     |        134.25 MB |              134.25 MB |
| Downloaded payload                   |        268.50 MB |              134.25 MB |
| Object-store HTTP requests           |            2,934 |                  2,916 |
| Provider HTTP requests               |            1,163 |                  1,336 |

Starts fell 33.3%, allocated time 7.7%, final-gap idle retention 80%, and remote
download payload 50%. Provider calls increased about 15%; warm resume/save/cycle
medians regressed. The trace saves unchanged data and does not establish universal
latency or cost savings. Host variation and lifecycle overhead were not isolated.

## Durability and accounting

All 208 timed restore/verify/save cycles matched exact bytes, modes, symlinks and
hardlinks. A separate embedded client retained one host beyond 61 real minutes,
published, observed source absence, then restored on a different host. All 158
entries / 322,845,310 logical bytes plus session files and acknowledged output
matched. Final released state, retained references and owned absence were verified.

Provider weighted-second samples with deletion-tail bounds gave compute values
of $0.05770–$0.05831 fixed and $0.05343–$0.05378 adaptive: $0.00392–$0.00488 saved
for the measured trace. All comparison starts were included; no start surcharge
was actually saved. Allocation-to-absence timing is an estimate, not an invoice.
The full comparison plus client check used 12 hosts, all retired, $0.13511 included
compute-credit value and $0 observed wallet debit. Storage/requests are separate.

Setup/harness corrections and a driver restart are retained limitations. Physical
usage includes that work, and caches/control traffic may be affected. Read-only
metering is outside workload timing. Command headroom retirement happened only at
a positively durable idle boundary; uncertain commands/saves were not replayed.

The evidence supports offering bounded longer/adaptive policy when avoiding starts
and cold reconstruction matters. It does not justify changing every workload's
default or retaining hosts indefinitely. [Configuration](../../docs/advanced-configuration.md).
