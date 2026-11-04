# gVisor and Podman comparison

The optional gVisor runtime passed a thirty-sample Boat/R2 comparison and two
source-deleted physical-host recovery tests. Podman remains the default. gVisor
adds a user-space kernel and an opt-in same-host memory suspension path. This
report records the November 3, 2026 filesystem/same-host-memory comparison. The
subsequent [November 4 portable-memory comparison](portable-memory-benchmarks.md)
qualifies R2 RAM recovery separately; it is not a rerun of these runtime timings.
See [runtime selection](runtime-comparison.md) for the current capability boundary.

## Measured latency

Frozen candidate `741759b35c79097c0e0a50e92cd970a049e4ac64`, Linux x86-64,
runsc `release-20261102.0`, systrap. Two groups ran in reverse mode order;
each mode used two physical source hosts and five cycles per host. Each arm
restarted its controller after its initial durable save. Every row verified the
exact persistent filesystem and original command output.

| Mode              | Samples | Resume to useful response, median / p95 | Durable save, median / p95 | Warm-controller response, median |
| ----------------- | ------: | --------------------------------------: | -------------------------: | -------------------------------: |
| Podman filesystem |      10 |                          5.74s / 17.59s |            19.28s / 27.20s |                            4.62s |
| gVisor filesystem |      10 |                           4.54s / 9.18s |             7.92s / 12.07s |                            4.54s |
| gVisor memory     |      10 |                           4.27s / 5.47s |              6.84s / 7.91s |                            4.16s |

Response latency includes resume, SDK command startup and observation of an actual
application response. API-running medians alone were 4.44s, 3.22s and 3.30s,
respectively. The warm subset excludes the first cycle after each controller
restart: eight samples per mode, with the physical host still retained.

The save difference is substantially explained by shutdown policy. The workload
runs as PID 1 without a SIGTERM handler: Podman consumes its existing ten-second
grace period; native filesystem stop kills and memory suspension freezes.
This is not evidence that gVisor uploads data three times faster.

| Observed stage median                    | Podman filesystem | gVisor filesystem | gVisor memory |
| ---------------------------------------- | ----------------: | ----------------: | ------------: |
| Quiesce / memory freeze                  |            11.26s |             0.48s |         1.66s |
| Capture host-control call                |             1.92s |             1.83s |         1.74s |
| Transfer and publication                 |             2.58s |             3.15s |         2.18s |
| Publication verification before cleanup  |             0.47s |             0.55s |         0.55s |
| Cached / memory resume host-control call |             4.00s |             2.60s |         2.05s |

Stages can nest, and medians do not add to an end-to-end median. Memory restore
also recaptures/verifies the filesystem identity; no unverified pages execute.

## Workload and recovery

Every arm used the same pinned image, one CPU and a 512 MiB workload limit:
a C process with a changing 64 MiB heap, a deterministic incompressible 64 MiB
file, small edits, empty and Unicode paths, executable modes, symlinks and
cross-root hardlinks. The memory path retained the same process token, increasing
counter and full evolving heap checksum across all ten cycles. Filesystem
resumes intentionally started a new process.

After deleting the source physical host, both Podman and gVisor recovered exact
files, modes, link groups and original binary command output from R2. Total
replacement qualification took 108.01s and 117.92s, including bootstrap, restore
and independent oracle/output checks. gVisor correctly reported
`memoryPreserved: false`: these tests used filesystem-only R2 checkpoints.
They did not exercise the later portable-memory feature or preserve external
socket connections. Both replacements completed another durable save.

Fresh-host creation through initial workload validation took 80–97s for Podman,
209–311s for gVisor filesystem, and 99s for the untainted gVisor memory arm. These
include bootstrap, image preparation, tool transfer and fixture setup; they are
not pure runtime startup measurements. The other memory arm's initial duration
includes a repaired harness invocation and is excluded. Warm results do not
justify claiming faster cold provisioning.

## Resources and costs

| Median observation                                | Podman filesystem | gVisor filesystem | gVisor memory |
| ------------------------------------------------- | ----------------: | ----------------: | ------------: |
| Sum of sampled process RSS                        |         64.72 MiB |        173.01 MiB |    238.04 MiB |
| Current-generation cgroup charged memory          |         64.54 MiB |         74.03 MiB |     75.23 MiB |
| Host busy CPU across mutation/check/save interval |             1.68s |             1.88s |         1.53s |
| Storage adapter calls, whole arms                 |               950 |               846 |         1,284 |
| Provider adapter requests, whole arms             |               364 |               293 |           345 |

RSS sums double-count shared pages. Cgroup counters cover the current generation;
inherited file-cache charges can belong to ancestors. CPU includes the independent
oracle, not just runtime execution. These are scoped observations, not sizing advice.

All six arms retained 76,874,597 unique checkpoint-frame bytes each (26 objects),
about 73.31 MiB, covering initial and changed histories. Request counts include
setup, verification and cleanup; they are adapter calls, not billable HTTP counts.
Host-direct signed transfers bypass the controller stream counters, so the harness
cannot establish total network bytes or a total upload bandwidth comparison.
Retained bytes are not a substitute for wire bytes.

Eight small hosts were started, including the two replacements, and all eight
were independently confirmed absent afterward. Complete active-state inventory
was empty. Observed physical compute was 2,247.56 seconds; provider-weighted
usage was 1,119 seconds because this host size has a 0.5 multiplier. Its provider
compute value was $0.01119–$0.01129, including a bound on the unsampled deletion
tail. Actual wallet debit was $0.00 under included credits; all eight start quotes
were $0.00. Hypothetical start charges at $0.03/$0.05/$0.07 would add
$0.24/$0.40/$0.56. No top-up or provider snapshot was used.

All modes already reuse Jetski hosts. This experiment does not demonstrate fewer
physical starts from gVisor versus Podman. Memory suspension retains an exclusive
host assignment; it trades retained compute and compatibility constraints for
process continuity. There is no cross-owner host reuse.

## Failures and limits

Two harness failures were preserved: an initial root-required fixture invocation
before writes, and a usage query that incorrectly expected a deleted source to
return 200 during idempotent retirement. Both were repaired using the same planned
host/operation identities; completed timing rows were retained, not silently rerun.
No timed row failed. Cleanup left all six sandboxes stopped, with no host leases,
pending operations or active checkpoint holds; acknowledged R2 histories remain.

Native qualification also exercises binary execution, PTYs, TCP forwarding,
resource enforcement and exact local recovery. Targeted tests cover stale,
missing, incompatible and corrupt memory, controller restart, lost acknowledgements
and uncertain source retention. This establishes the documented test scope, not
an absolute zero-loss or isolation guarantee. Two hosts per mode and shared-cloud
variation are insufficient to establish a universal performance advantage.

See [runtime configuration and recovery semantics](gvisor-runtime.md). No client
cutover or default switch is part of this experiment.
