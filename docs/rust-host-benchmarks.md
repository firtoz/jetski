# Rust versus Python host backend

## Result and recommendation

The native Rust backend is implemented and opt-in. **Keep Python as the default:**
this comparison found no consistent end-to-end speed advantage. Rust won one pair
and lost the reversed pair. The portable core, provider and storage boundaries
remain unchanged; selecting Rust does not change checkpoint publication guarantees
or save compute/start charges by itself.

Measured November 3, 2026, on Boat small hosts with R2. Python reference:
`8bb303f46c78c41d9a68f814953a96fa12467adc`; Rust runtime:
`6d6b6886a8669cbece3f26029f74c93f440ffde9`.
The separate static musl executable is 1,676,000 bytes, SHA-256
`5ba5edd2f469eecdda3388908a73a61c31bed1e4c3d24d9b722fdde7b39a540c`.
See [installation and selection](../host-rust/README.md) and the
[contract map](../host-rust/contract.md). Python remains available and unchanged.

## Matched measurements

Two host pairs, reversed order, five warm cycles per backend per pair: ten samples
per backend. Each used the same digest-pinned Linux image, 2 workload CPUs,
2,048 MiB memory, frame/pack geometry, R2 store and publication boundary. A cycle
resumed a stopped sandbox, changed 4 KiB of a deterministic 64 MiB binary plus
small files/modes/renames/deletes, checked an independent filesystem oracle, then
saved durably and released the assignment. Hardlink accounting makes the initial
logical oracle total 134,217,808 bytes across 11 entries. Timing includes orchestration,
provider transport, container work and storage, rather than just language execution.

| Metric                                    |           Python |             Rust |
| ----------------------------------------- | ---------------: | ---------------: |
| Median warm resume                        |           3.69 s |           4.33 s |
| Median verified save/release              |           7.21 s |           7.35 s |
| Median whole cycle                        |          13.45 s |          13.62 s |
| Mean whole cycle                          |          14.73 s |          16.08 s |
| Whole-cycle range                         |    11.01–26.98 s |    11.66–28.45 s |
| Initial cold readiness, two hosts         | 64.25 / 209.29 s | 59.23 / 135.33 s |
| Timed R2 upload payload, ten cycles       |      3,603,028 B |      3,609,328 B |
| Timed checkpoint restore payload          |              0 B |              0 B |
| Timed R2 HTTP requests                    |              320 |              320 |
| Timed authenticated provider API requests |              148 |              161 |
| Synchronous control user CPU, aggregate   |           9.37 s |           4.85 s |
| Synchronous control system CPU, aggregate |           5.62 s |          10.40 s |
| Synchronous control peak RSS              |       36,992 KiB |       36,864 KiB |

Rust's median resume was 17.4% slower, save 1.9% slower and whole cycle 1.3%
slower. Host variability matters: pair-one median whole cycles were 14.03 s Python
versus 12.55 s Rust; pair two was 11.82 s versus 17.17 s. Those opposite results
and the cold-readiness spread do not support a universal language speed claim.
Compression libraries and tar layouts also differ, so this is a backend comparison.
The identical request counts and very similar payloads show that the incremental
storage design was preserved; rewriting the host does not remove network round trips.

Resource samples cover synchronous host-control processes and waited descendants,
not detached command workers, the persistent container engine or total workload
CPU/RAM. Sample counts differ (138 Python, 151 Rust), including extra observations;
the CPU totals are scoped diagnostics rather than normalized whole-VM efficiency.
R2 figures are payload bytes, not total network traffic. The zero restore-read
row excludes the storage adapter’s internal verification readbacks after uploads;
it does not mean there was no download traffic during saves. Provider counts exclude
unauthenticated capability fetches and the separate read-only observer.

## Durability, interaction and consequential failures

All twenty timed cycles passed exact byte/mode/symlink/hardlink comparisons and
verified publication. One source-deleted replacement per backend recovered the
retained fixture exactly. Python's retained original command output was also
observed after recovery. The native installed path passed a 96 KiB binary file
upload/read, PTY input and resize, signal delivery, cancellation and authenticated
SSH-carried HTTP/binary TCP forwarding, followed by an exact final oracle/save.
Local coverage includes cross-language archives/journals, corruption and partial
transfer rejection, stale fencing, replay/lost acknowledgements and uncertain
execution handling: 59 Rust tests, 282 TypeScript tests and three installer tests.
These results are evidence within the tested boundaries, not an absolute zero-loss
promise or proof against every host/storage failure.

Two native setup bugs were found before admitting a workload: a missing fence
slot directory and rejection of the providers' null status payload. Both were
fixed, regression-tested and published before the successful native samples.
Their two failed starts remain in experiment costs. An existing pre-readiness
allocation can remain pending after losing its host; the failed empty scopes were
preserved and fresh qualification scopes used, rather than forging journal readiness.
This does not claim automatic recovery of every pre-admission allocation failure.

The reused fixture's duplicate entrypoint and a cleanup-script quoting error were
harness failures. Their known outcomes were preserved and only affected steps
repaired. No timed cycle was rerun to improve its result. During setup, the first
reference host reached its idle-retirement policy: its actual cold replacement
satisfied the required Python recovery gate, but its interrupted timing is excluded
from warm latency samples. Both required replacements occurred before the first
pair's five timed warm cycles. Original IDs and failed receipts remain private;
the clean reversed pair provides an additional comparison without hiding setup history.

## Costs and cleanup

The experiment used all eight allowed starts: four primary hosts, two replacements
and two native setup failure reserves. Every start was quoted at **$0** under
included starts. Wallet balance was **$52.54 before and after**; observed wallet
debit was $0, which does not mean compute has no economic value.

Using allocation admission through confirmed provider absence as conservative
upper bounds gives **1.7703 physical host-hours**, or at most **$0.0319** of compute
value at the contemporaneous small-host rate of $0.018/hour (0.5 provider size
weight). This includes setup/debugging and gaps before absence confirmation;
it is not an exact provider billing measurement. The usage observer failed locally
because its API wrapper rejected the `/usage` route, so no per-host usage samples
or exact compute debit attribution are available. The worst case of eight complete
one-hour small leases would have been $0.144 compute, plus hypothetical $0.56 if
all eight starts cost $0.07. Neither modeled amount is an observed wallet charge.
R2 service charges are outside this Boat allowance and were not separately billed
by this experiment's measurements.

Final bounded read-only inspection confirmed **provider 404 for all eight owned
hosts and zero active hosts**. Interactive exposure was revoked; no separate
proxy machines were allocated. Controllers and usage observer exited. Retained
checkpoint history remains intact; cleanup did not delete acknowledged roots.
No client cutover, default change or additional VM experiment accompanies this report.

## What to optimize next

Keep the interchangeable backend and use profiling before another rewrite.
The likely higher-value targets are reducing serial control/provider round trips
and redundant process launches while preserving durable intents and observation
semantics. This experiment does not justify spending more hosts to chase a Rust win.
