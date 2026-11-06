# Jetski on boxd and Boat

November 5, 2026. Both providers ran the same Jetski lifecycle and passed twenty
exact checkpoint cycles plus one source-deleted R2 recovery per provider.
The optional [boxd adapter](boxd.md) is included in `@firtoz/jetski@0.2.0`.
[Machine-readable measurements](benchmarks/boxd-boat-2026-11-05.json).

## End-to-end timings

Seconds; medians of ten cycles per provider unless otherwise noted. A cycle is
warm resume, command/mutation plus independent filesystem verification, then a
verified durable save and assignment release. Save includes R2 publication.

| Stage                                          |          boxd |          Boat |
| ---------------------------------------------- | ------------: | ------------: |
| Warm resume                                    |          1.76 |          1.76 |
| Work and independent oracle                    |          1.00 |          1.99 |
| Durable save                                   |          4.64 |          4.51 |
| Entire cycle                                   |          7.26 |          8.28 |
| Fresh Jetski readiness, two initial hosts      | 24.57 / 24.57 | 22.06 / 42.60 |
| Source-deleted replacement readiness, one each |         26.61 |         50.45 |

The pooled cycle median is about 12% shorter on boxd, while its save is about 3%
slower. This is not a universal provider ranking: the first pair favored healthy
Boat (6.47 seconds versus boxd's 7.03); the second favored boxd (7.42 versus 10.18).
Warm resume/save medians by pair are in the JSON. Work includes transport round
trips and verification; it is not a pure CPU benchmark. Readiness includes host
allocation, prerequisite/bootstrap reconciliation and Jetski setup, not native VM
boot alone. Medians of stages need not sum to the median whole cycle.

Each provider transferred 31,958 payload bytes in each direction and made 250
S3 HTTP requests across its ten timed cycles. The 4 MiB unchanged binary reused
incremental frames; these counters exclude initial priming, replacements and
native diagnostics. Initial fixture priming/verification/save took 14.39 / 17.83
seconds on boxd and 16.92 / 23.33 on Boat.

## Native disk and CPU screen

One run per initial host, on the host home filesystem, after bootstrap. boxd's
`/tmp` is tmpfs: the preliminary `/tmp` result was excluded. Both providers also
ran a separate `/dev/shm` control. Lower is better; all values are seconds.

| Test                                 | boxd 1 | boxd 2 | Boat 1 | Boat 2 |
| ------------------------------------ | -----: | -----: | -----: | -----: |
| 100 × 4 KiB synchronous writes       |  0.023 |  0.021 |  0.033 |  2.667 |
| SQLite, 100 FULL-synchronous commits |  0.051 |  0.050 |  0.065 |  5.531 |
| 64 MiB write plus fdatasync          |  0.084 |  0.067 |  1.325 |  1.309 |
| Allocate and SHA-256 128 MiB         |  0.149 |  0.150 |  0.075 |  0.099 |

The second Boat host reproduced severe synchronous-disk latency: about 55 ms per
SQLite commit versus roughly 0.5 ms on boxd. Healthy Boat was competitive on small
synchronous writes and faster in this CPU screen. The large final sync was slow
on both Boat hosts. These four machines establish variability in this sample,
not a provider-wide failure rate or a storage service-level guarantee.

## Durability and consequential failures

Two fresh initial hosts per provider, five cycles per host, with provider ordering
reversed between pairs. The fixture includes an incompressible 4 MiB binary,
empty files/directories, Unicode, mode 0640, hardlinks, a relative symlink,
Git-neutral `.git/HEAD` bytes and session/cycle markers. Independent shell checks
verify hashes, modes, link targets and shared hardlink inodes after reconstruction.
Both replacement tests confirm source absence, a different physical machine,
exact fixture/session recovery and retained original command output. A preliminary
local-store boxd test also restored into a distinct logical sandbox.

Three fresh boxd setup attempts (including the replacement) needed safe bootstrap
reconciliation after an unsuccessful control receipt. They reused their original
allocations; no extra machines were created. Readiness timings include those
attempts. The earlier onboarding preflight exposed a rootless runtime readiness
failure; diagnostic Podman inspection and an exact-bundle retry succeeded. Its
underlying readiness race has not been conclusively diagnosed. A successful final
workflow does not erase these failures.

All seven owned VMs, including the onboarding machine, were independently
confirmed absent. No snapshots or desktop runtime installation were used. Retained
R2 checkpoints and private controller metadata remain available; this experiment
did not start another garbage-collection test or alter other fixtures.

## Usage and cost

Different currencies and billing models are deliberately not converted. Values
below are bounded observations, not monthly quotations or future cost promises.

- **boxd:** four starts including onboarding. At 19:18 UTC, summed per-machine
  usage estimates were **€0.005749** (about 0.57 euro cents), of which **€0.002988**
  belongs to the three matched/replacement machines. The onboarding estimate is
  complete; the other three are explicitly marked incomplete by the provider.
  Settled organization usage-charge entries observed so far total **€0.003349**;
  this is a partial billing observation, not the final experiment invoice. Existing
  trial credits cover the run; no payment, top-up or plan change was made.
- **Boat:** three starts. The account's usage counter rose by **206
  provider-weighted seconds**. At its returned $0.036 per weighted hour this is
  **$0.00206 of compute value**. The wallet stayed **$52.54**, an observed **$0
  wallet debit**; included credit covered usage and starts. Per-host usage endpoints
  returned 404 after deletion, so this is an account-delta observation rather than
  an exact per-host invoice. Physical seconds and weighted seconds differ for small
  machines (0.5 multiplier).
- R2 requests/storage, controller compute and development time are excluded.
  The €5 / $3 test caps were not approached. No more hosts are needed for this run.

[boxd's published pricing](https://boxd.sh/pricing) charges €0.039 per active
vCPU-hour, €0.012 per active GiB RAM-hour and €0.00008 per written GiB disk-hour.
A fully busy 2-vCPU/8-GiB machine is about €0.174/hour before disk. Actual measured
usage can be much lower. Its native standby/hibernate behavior could change idle
costs, but this test disabled auto-suspend and did not qualify a native sleep pool.
Boat's fixed-size warm-compute and start tiers require a different workload model;
a tiny test run is not enough to declare either provider cheapest.

## Scope and decision

The controller was Node 24 with the Python host and rootless Podman; both used
the same digest-pinned Alpine workload, 1 CPU/512 MiB limits and the same R2 store.
Outer machine shapes differ: boxd 2 vCPU/8 GiB versus Boat small 2 vCPU/4 GiB.
Provider images, package versions and physical CPUs also differ. Ten samples per
provider share only two initial machines, so samples are correlated.

boxd is a useful optional machine host for Jetski. The checkpoint and pooling core
works across both, and remote recovery is independent of a retained source disk.
This run does **not** qualify boxd gVisor, native VM-memory forks/checkpoints,
Cloudflare Worker embedding or hosted PTY/TCP/preview workflows. Those remain
explicit capabilities to qualify separately. No production client switch, npm
release, universal speedup or zero-loss guarantee follows from this comparison.
