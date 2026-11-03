# Hosted performance qualification

## Current candidate: qualification33

Frozen runtime `62eab00` completed ten trials per arm across two fresh Boat host
pairs, reversing order on the second pair. Both arms use the same approved image,
two CPUs,2 GiB, native overlay and64 MiB fixture, ending at verified publication/
readiness and independent filesystem comparison. All20 comparisons match. Four
physical hosts were used, two per arm, and all hosts/controllers are retired.

| Warm metric                            | Reference median / sample p95 | Candidate median / sample p95 |
| -------------------------------------- | ----------------------------: | ----------------------------: |
| Durable save/release                   |                4.923 /5.903 s |                2.499 /3.853 s |
| Resume readiness                       |                2.018 /3.292 s |                1.104 /1.836 s |
| Complete work/save/resume/verification |               8.034 /10.271 s |                4.933 /6.119 s |
| Payload uploaded                       |                      1.042 MB |                      0.263 MB |
| Payload downloaded                     |                      0.005 MB |                          0 MB |
| Storage / provider API requests        |                        18 /16 |                      31 /10.5 |

Save/cycle medians improve on both pairs. Second-pair readiness is nearly tied
at1.054 versus1.042 s, so this is not an every-run or universal speed claim.
Sample p95 is the maximum of ten observations; bytes exclude HTTP overhead and
provider counts exclude signed data streams. Candidate coordination uses a
Durable Object/native R2; reference coordination uses Node/a native-R2 bridge.
Reference setup failed before timed work on the first pair and was repaired on
its original host. Its failure and retained compute remain in the receipts.
Setup, priming and final cleanup are outside warm rows.

Every candidate row uses the capability-negotiated combined cached resume, which
retains the ordinary claim/import/create checks and core reader fencing. The
command observer avoids unrelated reconciliation and observes stable command IDs.
Host I/O and control-plane placement still vary; this comparison does not isolate
the new composition's contribution to the save-time difference. Storage requests
remain higher despite fewer bytes and provider requests.

The current-build larger cold pair restores436,207,724 logical bytes exactly after
source deletion, including modes, links, saved output and repeated saves. Cold
readiness remains slower:188.574 versus47.045 s. Roughly151 s precede the
candidate's first host-status call;13 binary writes take20.840 s and import finish
7.852 s. Bootstrap is the next implementation target; the warm result does not
close cold parity. Both cold hosts/controllers are retired. See the
[active goal](goals/checkpoint-performance.md).

## Previous candidate: qualification32

The earlier ten-per-arm matrix was exact but host-pair reversal left consistent
parity unproven. Its pooled candidate/reference median save was7.196/10.3685 s,
readiness4.588/4.726 s and cycle16.4735/19.783 s. These rows are preserved without
estimated subtraction or pooling with the new candidate; detailed context is in
[the qualification32 report](benchmarks/qualification32.md).

## Previous candidate: qualification31

The frozen `ae17299` comparison completed ten trials per arm across two host
pairs, with all20 filesystem checks matching and all four hosts retired. Median
candidate/reference save is3.5355/4.308 s, readiness1.7625/1.168 s and complete
cycle6.7585/6.369 s. Sample p95/max cycle is8.890/7.590 s. Saves improve, but warm
cycle/readiness parity remains unmet. The larger-source pair measures13.664/
22.579 s, with exact fixtures and zero verification payload downloads. A later
qualification-driver correction removes a fixed post-completion wait; these
measured results are preserved unchanged. See the [active goal](goals/checkpoint-performance.md).

The following warm table is the earlier frozen `f02cc848` comparison, with
its own controller/host conditions; it must not be substituted for the latest build.

## November 2, 2026: matched warm comparison

Ten trials per arm completed across two independent Boat host pairs, alternating
order. Both workloads used2 CPUs,2 GiB, the same pinned Node image, native overlay
storage and the deterministic64 MiB fixture. Each trial included useful work,
verified R2 save/release, a fresh writable resume and an independent filesystem
comparison. All20 comparisons matched. Four physical hosts were used in total,
two per arm, and all were retired; bootstrap, priming and final cleanup are outside
the timed rows. Retained idle time was7.352 s across the complete matrix.

| Warm trial metric                      | Reference median / p95 | Jetski median / p95 |
| -------------------------------------- | ---------------------: | ------------------: |
| Durable save and release               |         6.595 /9.221 s |      4.434 /6.915 s |
| Resume readiness                       |         3.425 /3.930 s |      2.993 /8.542 s |
| Complete work/save/resume/verification |       11.876 /14.508 s |    10.786 /19.331 s |
| Object payload uploaded                |               1.042 MB |            0.263 MB |
| Object payload downloaded              |               0.005 MB |            0.263 MB |
| Storage requests                       |                     18 |                  32 |
| Provider API requests                  |                     16 |                  17 |

Jetski's median save, resume and complete cycle were lower on both host pairs.
Its resume/cycle tails were worse; with ten observations per arm, nearest-rank p95
is the sample maximum. This is a measured median improvement, not a universal
latency or cost claim. Bytes use decimal MB and exclude HTTP overhead; provider
API counts exclude signed data streams. More storage reads/requests remain a
tradeoff of the publication verification path.

The frozen warm implementation was `f02cc84854d0a3cbb4c5a39be967d6b21fd18cca`;
the reference was `eb592a78fb16d5e1bac4b82e8b43af8d3eeece58`. Jetski orchestration
ran in an embedded Durable Object with a native R2 adapter; reference orchestration
ran in Node with a native-R2 retention bridge. Earlier failed pre-trial source
exports and previous variants remain in private receipts and are not pooled into
this frozen comparison.

A subsequent change pipelines ordered source preparation with bounded storage
uploads. Its separate large-fixture sample measured25.574 versus16.619 s initial
save for the same436,207,724 logical-byte fixture. All source fixture comparisons
matched and both hosts were retired. The warm matrix above was not repeated for
this multi-pack change. A later bounded rolling window, which removes group
barriers while retaining the same upload/memory bound, measured27.246 versus
22.817 s in its separate first-save pair. Both fixture comparisons matched and
both sources/controllers were retired. This single pair does not establish a
speedup over the preceding implementation; the larger first-save parity target
remains unmet. See the [performance goal](goals/checkpoint-performance.md).

## November 2, 2026: bounded binary cold import

A cold-only comparison restored retained archives of the same436,207,724
logical-byte fixture to two fresh Boat hosts. Both source hosts and their original
controllers were confirmed absent first. Controller metadata was rehydrated from
an integrity-bound backup; no machine snapshot or source cache was available.
The candidate was `ff080b1f748bc39c68053abdd59b63458c6f97f4`, using optional16 MiB
raw imports. The frozen reference and workload resources were unchanged.

| Cold comparison metric                    |  Reference |                  Jetski |
| ----------------------------------------- | ---------: | ----------------------: |
| Allocation through verified readiness     |  218.556 s |               101.045 s |
| Restore after host bootstrap              |   42.249 s | Not separately measured |
| Archive payload restored                  | 201.600 MB |              201.573 MB |
| Candidate storage / provider API requests |          — |                  25 /42 |

Both normalized fixture oracles matched, including modes and two hardlink groups.
The complete candidate filesystem and saved command output also matched. Both
replacements completed a new durable save, were retired with provider absence
confirmed, and their temporary controllers were removed. Earlier helper failures
occurred before allocation and are preserved separately.

This is one host per arm, not a latency distribution. Bootstrap variation accounts
for a substantial part of the whole-readiness difference; the result does not prove
an import-only speed advantage. The preceding control-envelope candidate measured
193.631 s whole readiness in its earlier sample. The new result supports the raw
path's functionality and improves that observed whole time, while larger first-save
performance and the final downstream workflow remain open.

The streaming-integrity/capture-hash follow-on (`5b024d2`) measured43.869 versus
40.173 s in a new source-only pair. Source oracles matched and both hosts and
controllers were retired. Candidate counters included201.573 MB uploaded,
213.550 MB downloaded and125 storage requests. Capture requests took8.550 s;
source reads5.024 s; pack-write calls summed40.787 s and publication range checks
3.976 s. Call durations overlap and must not be added as wall-clock stages.
First-save parity remains unmet; this pair is not pooled with earlier candidates.

## Local storage-path screen

Five fresh processes per arm alternated buffered and streaming verification of
25 eight-MiB packs with32 logical ranges each (200 MiB total). Median local
assembly/hash time fell from455.779 to349.040 ms; median whole-process maximum
RSS fell from203,372 to187,860 KiB. All proofs matched. These measurements exclude
network/storage requests and do not establish hosted save parity. The follow-on
also hashes encoded archive bytes during writing, avoiding a complete temporary-file
reread while retaining source-member and stored-object verification.

## Historical comparisons

## November 1, 2026: default configurations

Twenty alternating warm trials completed on two Boat small hosts: ten per
implementation, one physical host per arm. Each trial changed a deterministic
64 MiB fixture, saved to isolated R2 storage, released the assignment, resumed a
fresh writable assignment and checked an independent filesystem oracle. All twenty
checks passed. Both hosts were retired with provider absence confirmed.

This is **not an equal-resource performance qualification**. The reference runtime
used two CPUs and 2 GiB per workload; Jetski used its defaults of one CPU and
512 MiB. The machine class and digest-pinned Node image were the same. The reference
used its existing dispatcher and framed R2 bridge; Jetski used the standalone
manager, SQLite and S3-compatible R2 adapter. Application and model latency were
excluded. Cold setup, initial priming and final release were outside warm timings.

| Median per warm trial                           | Reference |     Jetski |
| ----------------------------------------------- | --------: | ---------: |
| Work, save, resume and independent verification |   7.751 s |   31.681 s |
| Durable save and release                        |   4.966 s |   27.918 s |
| Resume readiness                                |   1.516 s |    1.792 s |
| Object payload uploaded                         |  1.032 MB |   4.178 MB |
| Object payload downloaded                       |  0.005 MB | 201.336 MB |
| Storage requests                                |        18 |         63 |
| Provider API requests                           |        16 |         44 |

Bytes use decimal MB and exclude HTTP overhead. Provider counts exclude data
streams accessed through file-transfer capabilities. Host lifetimes include setup,
controller work and waiting between alternating trials; they are not isolated
cold-start measurements. Two harness failures before priming were preserved and
excluded from the warm timings: a missing budget-journal import, and a bundled
script filename that activated an unintended CLI entry point. Recovery reused the
original host and retained the failed fixture.

The read amplification is a concrete regression to address before release.
`S3CheckpointStore.head` currently reads and hashes complete objects. Repeated
publication checks therefore reread unchanged frame bodies. Any optimization must
preserve verified publication, corruption detection, immutable object identities
and safe collection. Equal-resource repetition and failure/recovery tests remain
required; these results do not establish a Jetski speedup.

## Equal workload limits and conditional reads

A second twenty-trial run used two CPUs and 2 GiB per container on both arms,
with live cgroup limits checked before priming. The same small host class,
digest-pinned image, frozen fixture and alternating workload order were used.
All twenty independent recovery checks passed; two hosts were retired and a
subsequent provider inventory showed zero active hosts. The candidate was
`0080663`, including conditional object verification.

| Median per warm trial               | Reference |   Jetski |
| ----------------------------------- | --------: | -------: |
| Work, save, resume and verification |  17.243 s | 30.892 s |
| Durable save and release            |   7.659 s | 26.966 s |
| Resume readiness                    |   4.738 s |  2.325 s |
| Payload uploaded                    |  1.032 MB | 4.178 MB |
| Payload downloaded                  |  0.005 MB | 4.178 MB |
| Storage requests                    |        18 |       63 |
| Provider API requests               |        16 |       44 |

Conditional verification removed most repeated object-body downloads compared
with the first run, but did not establish competitive save latency. Different
frame sizes and transport round trips remain measured limitations. The reference
was slower than in the first run, so comparisons across runs cannot isolate the
optimization's latency effect. Cold setup and initial priming remain outside these
warm timings. This implementation does not promise universal speedups.


## Follow-on checkpoint optimization screens

Each row below is a separate five-trial-per-arm screen on a fresh host pair,
using the same frozen reference, 64 MiB fixture, approved image, two CPUs, 2 GiB
and durable-save/fresh-assignment recovery boundary. All completed trials passed
independent filesystem checks. **None is a replicated ten-versus-ten result, and
none meets the speed target.** Do not pool different candidates or controllers.

| Candidate and composition                          | Save: reference / candidate | Complete cycle: reference / candidate | Storage calls: reference / candidate |
| -------------------------------------------------- | --------------------------: | ------------------------------------: | -----------------------------------: |
| `98fe0ad`, Node/S3, individual 1 MiB objects       |            5.704 / 29.405 s |                      9.469 / 32.254 s |                             18 / 207 |
| `45b27a5`, Node/S3, physical packs                 |            4.389 / 17.517 s |                      6.510 / 21.184 s |                              18 / 40 |
| `083daad`, Node/S3, signal-aware idle              |             3.379 / 5.936 s |                       5.208 / 8.501 s |                              18 / 40 |
| `083daad`, embedded native R2 adapter              |             4.151 / 5.166 s |                       6.917 / 8.276 s |                              18 / 40 |
| `b691ba2`, embedded native R2, adaptive gzip       |             3.667 / 4.656 s |                       6.080 / 7.894 s |                              18 / 40 |
| `8c488fa`, embedded native R2, fewer control calls |             3.007 / 4.052 s |                       4.820 / 7.198 s |                              18 / 40 |

The reference uses Node orchestration with a Cloudflare native-R2 retention
worker. The embedded candidate runs core coordination and its adapter in a
Cloudflare Durable Object. These are different control-plane compositions;
changes between screens do not isolate transport costs. The `083daad` native candidate's
median readiness was 1.607 s versus 1.793 s; maximum saves were 5.413 s versus
5.213 s. Five observations per arm cannot establish stable tail estimates.
All screens uploaded approximately 1.04 MB per warm trial.

A second host pair for `98fe0ad` failed at the five-minute candidate creation
deadline before timed work, leaving a quarantined `creating` receipt. No workload
commands were admitted. Its evidence and checkpoints are preserved. All fourteen
hosts across the screens and failed setup were retired; subsequent inventory
reported zero active hosts. Embedded controller state was backed up before
removing its temporary controller. These counts are physical starts, not logical
sessions, and do not establish invoice attribution.

Passive persisted-phase observations isolated two quiesce intervals of 10.350
and 10.364 s in the packed screen. An idle PID 1 sleep consumed the stop grace.
The signal-aware candidate retains that grace, command settlement and observed
stopped-state checks; it also batches independent output retention and drains
failed siblings before allowing cleanup. Capture and control round trips remain
optimization targets. Later candidates still require the complete replicated
comparison, large cold/replacement recovery and downstream qualification.


Two further diagnostic hosts are excluded from the comparison table. One exposed
a priming failure: negotiated source ranges reached the controller intact, but a
shared decoder still enforced the ordinary output limit. The retained save journal
recovered on that same host after the bound was fixed; three exact cycles passed.
Both diagnostic hosts were retired. Four later attempts failed before timed
trials, bringing the retired follow-on total to twenty-three starts. Three
quarantined an empty runtime during initial creation; one stopped before reference
setup. A later runtime stack located image ownership remapping; its child wrote
1.13 GB and waited on filesystem journal commits before finishing. This refines
the earlier API/CLI contention hypothesis: shared-engine control alone did not
resolve startup. The harness used native overlay; the actual client selects FUSE.
The next frozen comparison uses that candidate setting, independently verifies its
mount program and reports the reference's differing native-overlay policy. Failed
setups remain separate from timing results; they are not successful comparisons.

The resulting FUSE screen completed five trials per arm with exact oracles and
owned cleanup. Median save was6.815 versus3.670 s, warm resume7.363 versus1.070 s,
and complete cycle17.649 versus5.685 s. Median changed upload fell to259,410
bytes versus1,042,257, but reduced bytes did not establish speed parity. Both
hosts were retired, bringing the follow-on total to twenty-five starts. A second
FUSE pair was not run because the measured gap was clear; the full replicated
acceptance comparison remains open.

Local encoding screens informed later candidates: adaptive gzip reduced a16 MiB
binary encode from307 to24 ms, and a source-like mix from180 to164 ms with0.36%
more encoded bytes. With physical packing, a64 MiB fixture's4 KiB edit changed
259,147 encoded bytes at256 KiB geometry versus1,045,819 at1 MiB. Both initial
archives used nine8 MiB packs; capture measured349 versus377 ms. These local
measurements do not establish end-to-end speed.


A subsequent native-overlay preparation pilot timed out before admitting an
assignment or starting timed work. The original operation, process I/O receipts
and state backup are retained; its owned VM was retired with provider absence
confirmed and its controller removed. The follow-on count is now26 starts, all
retired. This rejects early preparation of the unchanged mapping as a sufficient
solution; it is neither a successful speed trial nor evidence of lost bytes.
