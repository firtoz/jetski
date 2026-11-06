# Chromium fork startup improvements

The subsequent [transfer-tuning report](chromium-transfer-performance.md) reaches
5m53s with the same verified fork; this page preserves the first comparison.

The [recorded desktop example](../examples/07-memory-fork/README.md) exposed two
separate issues: deliberate controller scheduling gaps during object copying, and
expensive cold desktop-host preparation. Its original movie remains unchanged;
it is not an after-change benchmark.

## Copy scheduling

Previously each reconciliation advanced at most two objects. A 247-object copy
therefore required 124 scheduler turns, despite little actual local copy work.
At the embedded controller's one-second cadence this inserts about 123 seconds
between turns, excluding object I/O, publication and scheduler contention.

The default is now 16 objects per turn. Embedded/core callers can select
`checkpointCopyBatchObjects` from 1 to 256. The dedicated desktop example selects
256, so its 247-object graph can finish in one turn. Transfer remains sequential
and streaming: increasing the batch does not buffer an entire checkpoint or start
256 simultaneous uploads. Every object's verified receipt and cursor is still
persisted; publication still checks the whole graph before success. Owner scope,
source protection, cancellation and failure recovery remain unchanged.

A larger batch occupies an owner's reconciliation longer on slow storage, delaying
other lifecycle work. Use the default for general workloads; the larger example
setting favors its two-copy barrier. Store operations retain their existing bounds.
Cancellation races are checked between objects. The batch limit is not a wall-clock
deadline and cannot eliminate actual transfer or hashing costs.

## Reproducible local comparison

Run `npx tsx --test test/checkpoint-copy.test.ts` from the checkout. The 247-object
comparison uses SQLite and the local filesystem store, restarts the controller
mid-copy, verifies source retention and publication boundaries, and reads every
resulting object's exact bytes. It reports measured processing time separately
from modeled scheduler idle time. Objects are small synthetic compressed fixtures,
not the recorded 203.7 MiB Chromium memory image.

| Batch       | Reconciliation turns | Modeled idle between turns at one-second cadence |
| ----------- | -------------------- | ------------------------------------------------ |
| Previous 2  | 124                  | 123 s                                            |
| Default 16  | 16                   | 15 s                                             |
| Example 256 | 1                    | 0 s                                              |

These counts remove the demonstrated scheduling bottleneck. They do not establish
an equivalent reduction in hosted end-to-end latency. Lost-upload/publication
acknowledgements, interrupted streams, cancellation and source collection remain
covered by the existing failure tests.

## Prepared-host comparison — November 6, 2026

One actual rerun uses the same approved Playwright image, gVisor runtime, Boat
`default` machines, 2-CPU/2-GiB workloads and browser/file choreography as the
original. It prepares three owner-scoped hosts concurrently before creating the
source, keeps their approved images locally cached, and uses copy batches of 256.
Idle retention is 10 minutes instead of 2; shutdown bypasses retention in both runs.
The preparation is inside the video clock and all total times below.

| Observed stage                                  | Original cold run    | Prepared run    |
| ----------------------------------------------- | -------------------- | --------------- |
| Entire scripted workflow, including preparation | 1,055.6 s            | 643.1 s         |
| Prepare all three hosts                         | not a separate stage | 278.2 s         |
| Source sandbox ready from initial start         | 289.5 s              | 281.7 s         |
| Source sandbox ready after preparation          | not applicable       | 3.5 s           |
| Durable save + verification interval            | 72.4 s               | 66.9 s          |
| Independent copies A / B                        | 123.7 / 123.8 s      | 5.0 / 9.3 s     |
| Branch resume operations A / B                  | 463.8 / 463.8 s      | 194.4 / 194.4 s |
| Branch resume through verified viewer A / B     | 466.2 / 467.3 s      | 197.0 / 198.2 s |
| Retained source resume operation                | 7.0 s                | 5.5 s           |
| Native RAM-image bytes                          | 213,591,539          | 214,189,911     |
| Physical host starts                            | 3                    | 3               |

The complete workflow is **39.1% shorter** (6m52s saved), including preparation.
Branch resume operations are **58.1% shorter**. This combines moving cold work
onto the initial parallel-preparation path with removing copy scheduler gaps; it
is not an isolated estimate of either feature or a universal speedup. The initial
source readiness changed little because this run also begins with zero warm hosts.
Native RAM images differ by 0.28%, as expected for live browser captures.

Warmup is paid work, not free latency removal. Each target waited at least 141.3s
between all-hosts-ready and restore admission, about 4.71 aggregate host-minutes.
Provider creation timestamps through successful controller-close give conservative
lifetime upper bounds of 38.90 versus 35.83 aggregate default-host minutes. Earlier
per-host retirement is not timestamped individually, so these are not exact billed
compute durations, wallet debits or a precise cost-saving claim.

Both runs preserve the original JS nonce, initialization timestamp, memory-only
note and exact UTF-8 file, then independently reach source/A/B counters 4/9/6.
Both target restores report memoryPreserved=true without filesystem fallback.
All three candidate hosts were positively confirmed provider 404 after durable
close. Retained checkpoints remain private; nothing was deleted to make the run
pass. 397 tests, build, typecheck and lint pass.

[Watch the prepared demo](../examples/07-memory-fork/prepared-demo.mp4) (2m03s;
long waits explicitly labelled 16×). Full real-time recording: 10m50s, retained
privately alongside original 17m42s recording and sanitized reports. Independent
final/wait frames were reviewed and the viewing copy decodes without errors.

## Boundaries and remaining bottleneck

This is one before/after run on different physical machines, at different times;
provider/disk/network variation remains. The CPU/image policy and workload match,
but preparation, copy scheduling, startup concurrency and idle retention all
changed explicitly. Do not attribute modest save/source-resume differences to the
preparation change. Local checkpoint storage was used, not a new R2 qualification.

`prepareHosts` is one-shot, capacity-bounded and owner-scoped, with durable IDs,
expiry and ordinary lifecycle cleanup; default minimum warm capacity stays zero.
[API details](simple-api.md#prepare-hosts-before-demand). Image reuse is per host,
not a shared cross-host registry cache. Cached images skip repeated pulls; approved
digest checks and runtime-specific rootfs preparation remain in place.

Cold boot/image preparation still costs about4m38s when the pool is empty. Warm
branch disk/RAM recovery still costs about3m14s. The new stage observations show
filesystem restoration at most22.3s and native restore at most5.6s; chunk transfer
and control round trips account for much of the remaining path. Nested/concurrent
spans overlap and must not be summed. Further transfer work is outside this finite
comparison; no additional qualification loop or paid run is needed for this result.

To reproduce the sanitized read-only report:
`node scripts/report-memory-fork.mjs /absolute/private/run-directory`.
The example also records private `stage-timings.jsonl` for allocation, readiness,
portable restore, copy and store operations. `host.ready` includes bootstrap work,
not just provider boot. Timing sinks cannot change operation authority or success.
