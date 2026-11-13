# Runtime comparison — November 4, 2026

Controlled filesystem/application measurements inform runtime choice; they do not
establish a universal latency winner or change the Podman default.

## Controlled scope

Twenty Boat/R2 filesystem cycles: two fresh physical hosts per runtime, five
cycles per host, with reversed Podman/gVisor order in the second pair. All use the
same pinned Node image, one CPU / 512 MiB workload limits, isolated networking,
64 MiB heap, incompressible 64 MiB file and cross-root hardlink fixture. Controller
and physical hosts stay warm for timed cycles; provisioning and priming are separate.
Each cycle independently checks bytes, modes, symlinks, hardlinks and original
acknowledged output, performs the application work below, makes a small file edit
and acknowledges the same verified R2 filesystem publication boundary.

Both filesystem-stop paths now signal init with SIGTERM and allow ten seconds
before forced termination. The C fixture handles SIGTERM, syncs/closes its file
and exits. This gives both applications the same flush opportunity. Grace-timeout escalation and uncertain-signal behavior
have targeted tests. Memory suspension is a separate semantic operation, not
included as a faster substitute for filesystem stop.

Frozen artifact SHA-256:
`c956f57aa977f3e2b96e2944a922ef369b0df8599ff1b81338cb0c018c665c1d`.
Base revision `6521165`, plus the graceful-stop change and responding fixture in
this tree. The later selection helper does not affect the timed controller.
Runtime pin remains runsc `release-20261102.0`, systrap, Python host implementation.

## Lifecycle results

| Metric                     | Podman median / p95 | gVisor median / p95 |
| -------------------------- | ------------------: | ------------------: |
| Resume to useful response  |      4.577 / 8.057s |      4.365 / 6.013s |
| Durable filesystem save    |     8.551 / 16.108s |      7.411 / 8.562s |
| Quiesce host-control span  |       1.156s median |       0.293s median |
| Capture host-control span  |       1.771s median |       1.841s median |
| Finalize host-control span |       1.012s median |       0.604s median |

All twenty timed cycles matched. Combined medians favor gVisor by about 4.6% for
useful response and 13.3% for save, but the two host pairs disagree:

| Physical pair  | Podman response / save medians | gVisor response / save medians |
| -------------- | -----------------------------: | -----------------------------: |
| First          |                4.913 / 12.335s |                 3.717 / 6.702s |
| Reversed order |                 4.566 / 7.687s |                 5.354 / 8.108s |

This is insufficient to declare a consistent lifecycle winner. Older results with
a SIGTERM-ignoring fixture compared different shutdown semantics and are not valid
evidence of runtime superiority. Spans nest; medians must not be summed.

Both modes uploaded a median **1,880,957 R2 body bytes per cycle**, downloaded the
same amount including verification readbacks, and made 74 observed S3 HTTP requests.
Provider calls were 29 / 29.5 per cycle. Transfer counters observe request/response
bodies, not TLS headers or image pulls. Invalid legacy logical-byte counters are
excluded. There is no measured compression or byte-transfer advantage from
switching runtime in this comparison.

Cold setup to the first validated application response was 90.1 / 97.0s on the
Podman sources and 186.8 / 226.8s on gVisor. This includes provision, bootstrap,
image preparation and fixture compilation, not isolated container-start latency.
Two sources per runtime cannot establish a cold-start distribution.

## Application costs

[The executable workload](../../examples/runtime-workload.mjs) measures inside the
container, excluding controller round trips. Each sample checks exact outputs:
128 MiB SHA-256; 400 small-file create/stat/rename/read/delete operations; 32
32-KiB write-and-fsync iterations; 30 shell children; and 100 keep-alive loopback
HTTP responses of 32 KiB. Networking is sandbox-internal, not internet throughput.
CPU counters cover the measured Node process, not all forked children or runtime
helpers; sampled peak RSS is not a unique-memory sizing estimate.

| Boat application stage, ten samples/runtime | Podman median | gVisor median | gVisor / Podman |
| ------------------------------------------- | ------------: | ------------: | --------------: |
| SHA-256                                     |       51.45ms |       52.02ms |           1.01× |
| Metadata operations                         |       12.36ms |       56.52ms |           4.57× |
| Write + fsync                               |     1318.77ms |     1344.95ms |           1.02× |
| Spawn 30 children                           |       16.60ms |      160.68ms |           9.68× |
| Loopback HTTP                               |       22.15ms |       67.03ms |           3.03× |

Current-generation cgroup memory snapshots had medians of 64.57 MiB Podman /
77.66 MiB gVisor; generation peak medians were 89.13 / 108.31 MiB. These include
workload/runtime charges in that generation, not complete host or controller
memory. Ancestor page-cache accounting and snapshot timing limit sizing claims.

The syscall-heavy deltas matter even though this lifecycle fixture spends much
of its time in orchestration/storage. They are stage ratios, not multipliers for
entire builds, browser sessions or sandboxes.

## Laptop and private desktop

Twenty additional samples used the same pinned image on one Linux x86-64 laptop,
rootless Podman with crun or pinned runsc, one CPU / 512 MiB enforced limits, two
reversed runtime orders and five samples per arm. Application scratch storage
was tmpfs; its sync timings do not represent disk durability. Background desktop
activity and sequential placement remain limitations.

| Local application stage | Podman median | gVisor median |
| ----------------------- | ------------: | ------------: |
| SHA-256                 |       58.93ms |       57.93ms |
| Metadata operations     |       12.70ms |       56.52ms |
| Write + fsync on tmpfs  |        6.43ms |        8.18ms |
| Spawn 30 children       |       50.21ms |      487.71ms |
| Loopback HTTP           |       33.76ms |      104.60ms |

A real local integration failure was retained: runsc's default systemd cgroup
setup was denied; bypassing its cgroup management allowed startup but inspection
showed missing limits. That container was stopped. Accepted runs use a transient
user scope whose actual Sentry/init cgroup proves CPU quota, memory maximum and
PID maximum. No global system runtime or desktop session configuration changed.
Podman rejecting `NoCgroups` on runsc is also preserved; no limit was waived.

Both runtimes then ran headed Chromium on their own Xvfb displays, clicked a
button, typed text, checked the DOM and captured an identical 14,287-byte PNG.
One observation per mode: inside-container display/browser launch and check
1.31s Podman / 3.59s gVisor; input plus
screenshot 0.30 / 0.58s. These are compatibility observations, not latency medians.
Podman's host-side file copy could not extract the gVisor virtual file; a scoped
runtime exec stream transferred it with exact byte/hash verification instead.

This uses the official digest-pinned Playwright image and disables Chromium's
nested sandbox explicitly for the trusted local fixture. It qualifies neither
untrusted browsing nor access to the real desktop. There are no host display,
profile, credential, clipboard or input-device mounts, host networking or published
ports. [Demo and selection boundaries](../../docs/runtime-selection.md).

## Recovery and cost closure

Both source-deleted physical replacements passed exact filesystem/mode/link and
retained-output checks, then saved again. Podman took 217.6s and gVisor 114.1s,
including provisioning/bootstrap and independent verification. These are single
observations on different hosts, not a cold-recovery performance distribution.
Both intentionally restarted processes: these filesystem-only checkpoints do not
claim RAM continuity. The prior portable-memory qualification remains separate.

All six owned Boat hosts returned provider 404 in a fresh audit; complete active
inventory was empty. Four logical sandboxes are durably stopped with retained
roots, no lease/pending operation and zero registry reader/writer actors. All
owned local containers, transient scopes and runtime processes are absent.
Private pinned binaries and downloaded images remain available for reproducibility;
no global runtime defaults or desktop services were changed.

Observed physical compute was 1,412.4 s; weighted usage 703 s (small-host factor
0.5), valued at $0.00703 included compute, bounded above by $0.00710 including
sampling tails. Start quotes/observed wallet debit were $0 under that account's
allowances. Storage/requests are separate; this is not a free-compute promise.
No timed Boat row failed or was replaced; local cgroup/virtual-file failures above
remain material compatibility limits.

## Decision

A gVisor-preferred policy is reasonable where its extra application-kernel boundary
or qualified process continuity is useful and the workload passes admission.
The tests establish real benefits and real syscall costs. Prefer gVisor-required
when that isolation is mandatory; permit Podman fallback only for explicitly
approved, known unsupported prerequisites. Never downgrade after an uncertain
command, corrupt checkpoint or save failure.

This frozen comparison used isolated networking. Current public-egress support
has [separate profile evidence](network.md); Rust/gVisor composition is unsupported.
Personal-laptop use can avoid cloud starts for local work, but consumes local
resources and depends on laptop availability. These results do not switch
standalone defaults, adopt the laptop as a managed Jetski host, cut over a client,
or qualify another memory/profile combination.
