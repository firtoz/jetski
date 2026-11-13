# Qualification and evidence boundaries

Use this page to assess a contract or plan a changed-path check, not as a run diary.
Local fixtures, native CI and hosted tests establish different things. Preserve
frozen workload/build/profile boundaries when reusing evidence; do not turn a mock,
an old deployment or one successful sample into universal qualification.
[Acceptance matrix](implementation.md) · [test procedures](testing.md).

## Evidence map

| Contract                     | Evidence                                                                                                           | Boundary                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Public package/API           | Independent packed installs, strict NodeNext/Worker/platform fixtures, import/bundle checks and example typechecks | Compile/import support; not live Worker or provider qualification                           |
| Lifecycle and recovery       | SQLite reopen, lost acknowledgements, cancellation, stale fences, quarantine and cleanup tests                     | Local failure coverage; unknown external effects stay unknown                               |
| Filesystem durability        | Independent hosted bytes/modes/symlink/hardlink oracles, publication proofs and source-deleted replacements        | Declared persistent paths and tested profiles, not entire hosts or zero-loss guarantees     |
| Remote storage               | Local/S3 consistency contracts, live R2 checksum/range/publication checks                                          | Other endpoints need their own qualification; metadata backups remain required              |
| Retention/collection         | Reader/writer/publication races plus the baseline real-grace fixture below                                         | Later formats and wider automatic collection need their own scoped evidence                 |
| Interactive access           | Native PTY/SSH/TCP, browser HTTPS/WSS, credential/origin denial, scoped hosted provider cases                      | Not every browser, reverse proxy or deployment; EOF is not authenticated completion         |
| Process memory               | Compatible gVisor heap/token/open-file and exact filesystem replacements                                           | Explicit runtime/image/helper ABI/kernel/CPU compatibility; no external-socket continuation |
| Provider/runtime/performance | [Focused reports](benchmarks/README.md)                                                                            | Their sample sizes, failures and timing/cost limits remain part of every claim              |

The local recovery slice exercises generated command intent discovery after lost
acknowledgement and actual SQLite reopen, GET-only reconnect/cursors, abort without
cancellation and terminal input receipt reuse. Typed quarantine and capability
outcomes include a local HTTP round trip. Host-only machine readiness cannot
substitute for sandbox attestation. None of these tests allocates a provider VM.

The portable browser bundle excludes Node/database/SSH/provider SDK dependencies.
Separate Boat composition permits its existing Node crypto/path compatibility
requirements while excluding filesystem/SQLite/SSH/provider SDK loading. Native
R2 has its own Node hashing requirement. The advanced browser recording demo is
typechecked, not automatically executed by package checks.

## Real-grace collection

The frozen baseline (`7240e47`; [CI](https://github.com/firtoz/jetski/actions/runs/41332633249))
includes an independent R2 fixture whose original clock, roots and generation were
not changed. It became eligible November 1, 2026 at 23:51:52 UTC; collection at
November 2 00:01:46 UTC deleted its one eligible retired frame. Early collection
deleted nothing. Reusing the collection ID returned its persisted result without
another deletion.

After deleting source archives, fresh object downloads/full hashes restored the
pinned retained version. The independent oracle matched bytes, modes, links,
Unicode and rename/delete results. Permanent identity reservations remained.
No VM was used. This establishes that fixture's elapsed real-grace boundary,
not every later format, host replacement or automatic history expiration.

## Runtime selection

Two scoped hosted cases on November 4 used separate owned Boat hosts, the same
pinned Node image, one CPU/512 MiB and public egress. Qualified preferred policy
selected gVisor; deliberate workload exclusion selected Podman only with the
`workload-compatibility` reason authorized. Both passed DNS/HTTPS, Git/package
checks, exact 10-entry/1,052,362-byte files, original binary output, durable stop
and same-host resume. Decisions persisted after retirement. The controlled
exclusion does not prove physical-host incapability; memory-required downgrade
refusal is covered separately by local selector tests.

## Upload staging

A single-host R2 comparison restored a 151-entry/165,926,093-byte archive into four
distinct sandboxes, ordered serial/staged/staged/serial. Serial took 31.529/34.417 s;
staging 33.221/30.936 s. All independent byte/mode/link digests matched. Two samples
per mode with overlapping results (2.7% average difference) do not establish a
material speedup; serial remains default. Commit/extract/flush spans nest and must
not be added to end-to-end timing. Host disk performance matters.

## Consequential failures and remaining limits

- Hosted uncertain commands/saves retained quarantined sources. Emergency forensic
  archives were not successful managed releases; [provider evidence](benchmarks/providers.md)
  retains the distinction.
- An R2 HTTP 502 blocked release until reconciliation and exact recovery. Failed
  timing was excluded with its attempted sample preserved; [host stages](benchmarks/host-stages.md).
- A memory replacement's pre-effect parent-permission failure needed a guarded
  repair. Its elapsed time includes diagnosis and is not a clean latency sample;
  [memory evidence](benchmarks/memory.md).
- Native exec once reported a PID inconsistent with its sandbox `/proc`, breaking
  descendant cleanup. Shared sandbox PID namespace fixed the mismatch; targeted
  live cancellation reaped descendants. Commands within one sandbox are not
  separate security principals.
- Baseline Podman removal sometimes waited for monitor processes to drain;
  immediate monitor cleanup was not established. Retire only after observed absence.
- Missing nft hooks, unsupported terminal signalling and ineffective local cgroups
  must fail closed or use only their specifically verified compatibility paths.
  They never authorize weaker isolation or blind command replay.

No new native/provider/storage qualification follows from documentation changes.
Host/cache/storage variances, incomplete legacy error classification, single-
controller scope and missing hard per-owner byte quotas remain documented limits.
Historical measurements do not qualify every profile or operator backup, and
hosted results do not establish a managed-service SLA. Routine receipts, secrets,
account balances and process handles stay private; superseded narratives stay in
version history.
