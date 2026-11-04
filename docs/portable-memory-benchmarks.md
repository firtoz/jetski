# Portable process-memory measurements

Opt-in gVisor process checkpoints can publish verified memory chunks together with
an exact filesystem checkpoint in S3-compatible storage. This comparison used R2
and small Boat hosts, one vCPU / 512 MiB workload limits and a changing 64 MiB heap.
Podman and ordinary filesystem/default same-host memory behavior are unchanged.

## Frozen comparison

Three cycles per mode/profile, eighteen timed cycles total; six source hosts and
one source-deleted replacement for each of the compressed-full and incremental
low-change arms. Initial provisioning and priming are separate from timed warm
cycles. All modes acknowledge the same verified combined filesystem/memory boundary.
Each query checks the complete heap checksum, random process token, counter and
open-file offset/content; an independent oracle checks bytes, modes, symlinks and
hardlink relationships. Retained command output also survives.

| Profile | Memory mode      | Resume median | First response median | Durable save median | New memory/save median |
| ------- | ---------------- | ------------: | --------------------: | ------------------: | ---------------------: |
| low     | raw-full         |         3.22s |                 4.29s |              65.76s |              64.19 MiB |
| low     | gzip-full        |         3.77s |                 6.17s |              42.71s |               0.56 MiB |
| low     | gzip-incremental |         2.62s |                 2.97s |              12.05s |               0.07 MiB |
| high    | raw-full         |         3.17s |                 4.13s |              63.65s |              64.20 MiB |
| high    | gzip-full        |         3.81s |                 4.80s |              61.77s |              64.07 MiB |
| high    | gzip-incremental |         3.26s |                 4.26s |              61.99s |              64.12 MiB |

Low change mutates a tiny part of compressible heap; high change rewrites the
entire heap with entropy. Each profile uses the same workload across modes, with
independent random process tokens. Three repeated cycles on one host per arm do
not establish universal speedups. The first raw/low sample retains its original
operation timings, but its request totals include disclosed fixture-repair traffic.

## Transfer and retained history

Body counters observe provider binary downloads/uploads and actual S3 SDK bodies,
including verification readbacks; they are separate from logical source reads.
They exclude HTTP/TLS headers and provider-internal image pulls. Attempted uploads
are an upper bound when a failed connection prevents exact delivery observation.
Legacy logical-upload counters were invalid and are excluded.

| Arm                   | Provider body down/up per cycle | R2 body down/up per cycle | R2 requests/cycle | Retained memory history |
| --------------------- | ------------------------------: | ------------------------: | ----------------: | ----------------------: |
| raw-full-low          |                    66.0/0.0 MiB |             66.0/66.0 MiB |               428 |               256.7 MiB |
| gzip-full-high        |                    65.9/0.0 MiB |             65.9/65.9 MiB |               428 |               256.3 MiB |
| gzip-incremental-low  |                     1.9/0.0 MiB |               1.9/1.9 MiB |               178 |                 0.4 MiB |
| raw-full-high         |                    66.0/0.0 MiB |             66.0/66.0 MiB |               428 |               256.8 MiB |
| gzip-full-low         |                     2.4/0.0 MiB |               2.4/2.4 MiB |               428 |                 2.8 MiB |
| gzip-incremental-high |                    66.0/0.0 MiB |             65.9/65.9 MiB |               426 |               256.5 MiB |

Retained history includes initial priming and all acknowledged portable saves;
replacement arms also include their post-recovery save. Unique object references
are counted once. It is not a sum of overlapping checkpoint-root sizes. Incremental
saves reuse verified immutable chunks and publish complete manifests, without base
chains. Native capture still reads full image files: this is incremental transfer
and retention, not native dirty-page checkpointing.

## Replacement recovery

| Mode             | Provisioning + restore + verification | Preserved state                                        |
| ---------------- | ------------------------------------: | ------------------------------------------------------ |
| gzip-incremental |                                839.7s | Full heap/process/open-file and exact persistent files |
| gzip-full        |                                233.3s | Full heap/process/open-file and exact persistent files |

### Recorded restore stages

Host reconstruction/verification and native effects are separate from controller
RPC spans. The repaired incremental case excludes its diagnosis pause from these
component spans, while its full elapsed time above retains that pause.

| Mode             | Filesystem import | Native-file reconstruction | Native-file proof | Native restore effect |
| ---------------- | ----------------: | -------------------------: | ----------------: | --------------------: |
| gzip-incremental |            14.38s |                      1.33s |             0.03s |                 0.17s |
| gzip-full        |            15.54s |                      1.46s |             0.08s |                 0.12s |

Before each deletion, retained objects were independently read/hash-verified and
a fresh source filesystem oracle matched. Provider 404 preceded new placement.
The incremental replacement first needed a guarded repair of its outer assignment
parent after a pre-effect permissions failure. Its elapsed time includes diagnosis
and repair, so it is not a clean restore-latency sample. The full-compressed
replacement tests the automatic fixed path. In both cases, a physically different
host restored the process, then published another portable
checkpoint. Filesystem-only fallback is not counted as memory recovery.

## Save stages and resource use

These spans nest and must not be added together. Upload sums are serial RAM object
publication spans including readback. Encoding includes hashes, round-trip checks
and pack writes/sync, rather than pure codec CPU.

| Arm                   | Freeze | FS capture | Memory encode/hash | RAM upload/readback | Publication proof |
| --------------------- | -----: | ---------: | -----------------: | ------------------: | ----------------: |
| raw-full-low          |  1.76s |      1.68s |              1.43s |              37.89s |             1.63s |
| gzip-full-high        |  1.93s |      1.70s |              1.55s |              39.02s |             2.14s |
| gzip-incremental-low  |  1.47s |      1.63s |              0.16s |               1.04s |             0.62s |
| raw-full-high         |  1.83s |      1.73s |              1.44s |              39.06s |             2.01s |
| gzip-full-low         |  2.08s |      1.89s |              0.23s |              27.19s |             1.85s |
| gzip-incremental-high |  2.10s |      1.76s |              1.56s |              40.82s |             2.01s |

| Arm                   | Cold setup to first response | VM busy CPU, median | Workload cgroup peak, max |
| --------------------- | ---------------------------: | ------------------: | ------------------------: |
| raw-full-low          |                       221.5s |               2.75s |                 157.8 MiB |
| gzip-full-high        |                       266.9s |               2.93s |                 146.6 MiB |
| gzip-incremental-low  |                       122.5s |               2.00s |                 144.4 MiB |
| raw-full-high         |                       202.6s |               2.58s |                 144.2 MiB |
| gzip-full-low         |                       182.2s |               2.07s |                 146.4 MiB |
| gzip-incremental-high |                       186.7s |               2.73s |                 144.0 MiB |

Cold setup includes host/bootstrap, fixture preparation and its first useful
response, before initial checkpoint publication. VM busy CPU includes mutation,
oracles, transfer agents and background work between samples. Cgroup peak includes
workload/runtime memory, excluding host capture helpers and controller memory.
Summed process RSS can double-count shared pages and is not used as a memory-cost
claim. These are coarse resource observations, not isolated per-function CPU costs.

## Local codec isolation

Thirty additional local samples used synthetic 64 MiB native-image-shaped files.
They measured codec/reconstruction costs without a network or native process.
For low change, compressed incremental follow-ups stored about 6 KiB instead of
64 MiB raw; high-change entropy produced no reuse and no compression saving.
These synthetic ratios are not substituted for the hosted measurements above.


| Local profile             | Mode             | Capture wall/CPU median | Reconstruct wall/CPU median |
| ------------------------- | ---------------- | ----------------------: | --------------------------: |
| small-change-compressible | raw-full         |              184/166 ms |                  150/129 ms |
| small-change-compressible | gzip-full        |              266/259 ms |                  144/125 ms |
| small-change-compressible | gzip-incremental |              272/265 ms |                  151/129 ms |
| full-change-entropy       | raw-full         |              202/188 ms |                  166/153 ms |
| full-change-entropy       | gzip-full        |              392/377 ms |                  212/198 ms |
| full-change-entropy       | gzip-incremental |              407/396 ms |                  227/213 ms |

Local process peak RSS includes fixture generation and full-file oracle reads;
it does not isolate codec buffering. Native checkpoints were produced uncompressed
so all transfer modes use comparable source files; native flate was not a separate
qualified mode.

## Compute and storage costs

Provider usage reports weighted seconds; small hosts have multiplier 0.5. Compute
value, included-credit consumption, start quotes and observed wallet changes are
reported separately in the final accounting. Pre-delete sampling leaves a bounded
unsampled tail; compute value is not automatically a wallet debit.

R2 Standard list pricing checked November 4, 2026: $0.015/GB-month, $4.50 per
million Class A requests and $0.36 per million Class B requests; egress is free.
Account-wide free allowances and billing-unit rounding apply. Marginal models are
not invoices. [Cloudflare pricing](https://developers.cloudflare.com/r2/pricing/).


| Experiment accounting                                      |   Measured value |
| ---------------------------------------------------------- | ---------------: |
| Physical Boat starts                                       |                8 |
| Observed physical host time                                |      1.164 hours |
| Provider-weighted seconds                                  |             2093 |
| Included compute-credit value                              |         $0.02093 |
| Unsampled compute-value tail, upper bound                  |      $0.00000796 |
| Start quotes / observed wallet debit                       |    $0.00 / $0.00 |
| Reserved / approved allowance                              |   $0.848 / $3.00 |
| Retained objects: FS + RAM / RAM only                      | 1.518 / 1.079 GB |
| Retained roots / active reader-writer actors after cleanup |           82 / 0 |

At the list rate, all retained test objects represent about **$0.023/month**
of storage value, including about **$0.016/month** for RAM objects.
This models a full month before shared account allowances and billing rounding;
it is not an observed Cloudflare invoice. The measured object-upload body total
matches the unique retained-reference byte total. Provider compute is consumed
from included credit; the account wallet was unchanged. All eight starts had a
zero start quote. These observations do not promise free starts on another account.

## Practical choice

Use gzip with reuse for compressible, lightly changed memory when remote process
recovery is needed. In this fixture it cut median durable save time from 65.76s to
12.05s (about 82%), with about 70 KiB of new memory objects per follow-up save.
Full-change entropy still uploaded roughly 64 MiB and showed no meaningful saving.
Keep identity available for that case; no universal faster mode or default change
is claimed. Storage/request latency dominates these traces more than codec CPU.

## Failures and limits

- A controller response-cap mismatch rejected the first export before a network
  request. The scoped fix retains ordinary endpoint bounds and original IDs.
- The initial oracle preceded creation of the declared open file. Repair required
  the complete sealed filesystem identity and known file bytes/mode. Later arms
  sample after initialization; original failed attempts are preserved.
- A restored outer assignment parent needed the same root-owned traversal policy
  as ordinary creation. The fix changes no declared persistent root bytes/modes.
  Preparing replay removes only positively empty cgroups before rebuilding.
  The native CI fixture now exercises this path without manual parent repair.
- The first nine warm cycles used the response-bound fix; the last nine use the
  parent-handoff fix. Codec, storage and warm-resume paths are unchanged. Exact
  artifact hashes and the upgrade boundary remain in private receipts.
- Runtime/image/helper ABI/configuration must match; the target needs compatible
  kernel and a CPU feature superset. This is qualified compatibility, not arbitrary
  process migration between unrelated machines.
- RAM checkpoints do not preserve an entire host or promise external TCP sessions
  and remote side effects. Unacknowledged writes remain outside the recovery point.
- Source uncertainty retains/quarantines its assignment; restore uncertainty is
  observed without repeating native effects. Existing fencing, retained roots,
  reader/writer exclusion, pins and fail-closed collection remain authoritative.
- No new client/default cutover, production migration or automatic memory-history
  expiration is part of this qualification.

All positively owned test hosts are retired with provider absence confirmed.
Private receipts retain failures, original IDs, object proofs and cleanup evidence;
credentials and memory images are not public.
