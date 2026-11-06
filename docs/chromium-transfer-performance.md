# Chromium transfer tuning — November 6, 2026

The real three-way RAM/disk fork reaches its verified result in **5m53s**, versus
17m36s originally and 10m43s after initial host preparation. All runs use the same
approved Playwright image, gVisor version, Boat `default` class and 2-CPU/2-GiB
workloads. This is an observed comparison, not a universal speed guarantee.

## Measured results

| Stage                                          | Original                | Prepared baseline | Final tuning      |
| ---------------------------------------------- | ----------------------- | ----------------- | ----------------- |
| Workflow to verified result                    | 1,055.6 s               | 643.1 s           | **352.7 s**       |
| Controller start through durable close/cleanup | 1,145.5 s               | 722.1 s           | **394.9 s**       |
| Initial preparation                            | implicit in cold starts | 278.2 s           | 193.3 s           |
| Source ready after preparation                 | n/a                     | 3.5 s             | 4.0 s             |
| Durable RAM/disk save + verification interval  | 72.4 s                  | 66.9 s            | **22.9 s**        |
| Independent copies A / B                       | 123.7 / 123.8 s         | 5.0 / 9.3 s       | **2.0 / 3.5 s**   |
| Branch resume operations A / B                 | 463.8 / 463.8 s         | 194.4 / 194.4 s   | **47.6 / 47.6 s** |
| Branch resume through verified viewer A / B    | 466.2 / 467.3 s         | 197.0 / 198.2 s   | 50.1 / 49.2 s     |
| Retained source resume operation               | 7.0 s                   | 5.5 s             | 4.8 s             |
| Physical starts per completed run              | 3                       | 3                 | 3                 |
| Aggregate host-minute reservation upper bound  | 38.91                   | 35.88             | 19.54             |

The final workflow is **66.6% shorter than the original**, or **45.1% shorter than
the prepared baseline**. Preparation is included. The first row ends at the final
independent state proof; the second also includes recording encoding, final saves
and cleanup. Lifetime bounds run from slot reservation to successful controller
close; earlier individual retirement is not timestamped. They are not exact billed
usage, wallet debits or a claim that total cost halves: physical start counts stay
unchanged. Retaining warm hosts is paid compute.

Every successful run keeps the original random JS nonce, initialization timestamp,
memory-only note and exact UTF-8 file. Final source/A/B counters are 4/9/6, with
independent file changes. Both target restores report memoryPreserved=true and no
filesystem fallback. Native image size varies slightly; final is 213,039,682 bytes,
represented by 53 distinct memory objects totaling 35,275,742 stored bytes.

## Changes kept

- **Fewer scheduling gaps:** the dedicated demo copies up to 256 streamed objects
  per turn; the general default stays 16. Every object/publication remains verified.
- **One-shot host preparation:** owner/capacity/lifetime scoped, no automatic warm
  replenishment. Existing idle hosts are rechecked across multiple startup waves;
  bounded readiness probes prevent peers waiting behind a long bootstrap.
- **Frozen bootstrap assets:** one detached asset version per controller. A new
  controller still rejects an incompatible installed identity instead of upgrading it.
- **4 MiB desktop memory chunks:** fewer objects; not a global default. Coarser
  chunks can increase bytes reuploaded after small changes. Incremental reuse,
  independent compression and complete manifests remain intact.
- **Durable object progress:** separate fenced KV rows avoid redundant status RPCs
  for fresh objects and avoid quadratic metadata rewrites. Uncertain/restarted
  objects still observe the host. Native effects never blindly replay.
- **Bounded parallel control writes:** opt-in 1/2/4; every started worker drains
  before fallback, reader closure or native execution. Shared binary import sinks
  remain serial. Core default stays 1; the qualified demo uses 4.
- **Binary source downloads:** Boat's optional `archiveReads: true` connects the
  existing immutable source binding. Only a known ignored HTTP Range may switch
  to the same fenced control read; auth/server/corruption errors fail. All hashes,
  decoded bounds and final publication checks still apply.
- **File upload initialization:** a durable, acknowledged initialization avoids
  repeating begin before every chunk. Restart/spec/generation and final hash/
  publication checks remain.
- **Image durability barrier:** on supported Linux >= 5.8, a checked filesystem
  barrier opened before copying replaces per-file flushes after the same bounded
  tree validation. Unsupported hosts keep per-file fsync; EIO/ENOSPC never become
  successful preparation. See [Linux syncfs semantics](https://man7.org/linux/man-pages/man2/syncfs.2.html).

## Diminishing returns and limits

The clean two-worker/control-read candidate reached 471.0 s. Moving to four workers
and binary reads reached 352.7 s; these are two changed stages, not an isolated
concurrency experiment. Save time fell 67.1→22.9s. Maximum object-transfer time fell
25.0→17.8 s: about 7s, only 1.5% of the preceding whole workflow. Higher concurrency
adds resource/API pressure; no unbounded fan-out or further trial was justified.

Cold image work now dominates: final initialization still takes 193 s. Observations
separate image download, rootfs copy, mapped-image preparation and validation/
flush. A representative preceding run measured 69–81s downloading, 41s copying and
13s validating/flushing. Bootstrap results vary across physical hosts; no isolated
causal speedup is claimed for the new filesystem barrier. Further large cold-start
wins require a thinner approved image, a different image-mount/distribution design,
or avoiding a cold host through warm reuse. Those alter the architecture/workload;
they are not free parameter changes. Native resume and remaining integrity checks
are retained. Scripted pacing and viewer reconnection are included, not optimized
away to make the video look faster.

This is a small sequence on different hosts/times, not a statistical benchmark.
Local storage was used; this is not new R2 or cross-provider qualification. Two
failed trials are excluded: an operator asset edit correctly triggered identity
rejection; multi-wave readiness exposed a pool bug that expired before any workload.
Both were fixed, retained and cleaned. No failure was relabelled a timing success.

All 12 owned tuning hosts are confirmed absent, including failed trials; no snapshots
or top-ups. 406 TypeScript and 241 Python tests pass, alongside build/typecheck/lint.
Private receipts/archives and real-time movies are retained. See the
[recorded example](../examples/07-memory-fork/README.md) and sanitized read-only
report command in [the earlier comparison](chromium-fork-performance.md).
