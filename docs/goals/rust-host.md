# Rust host backend and matched Python comparison

## Objective and constraints

Implement an opt-in native Rust host backend and compare it with the frozen Python
reference. Read and maintain `/home/frtn/work/2026/jetski/docs/goals/rust-host.md`
at each continuation and after compaction; pursue this complete finite scope.
Keep provider, storage, control-plane and runtime boundaries replaceable. Python
remains the default and reference; no implicit changes to installed immutable
bundles, live assignments, retained archives or clients.

Rust must implement the host control/data path rather than invoke Python for the
measured operations. Existing bootstrap and the small native helpers may remain
where documented. Preserve the versioned wire protocol, execution identities,
command/output/cancel and interactive behavior, exact filesystem bytes/modes/links,
checkpoint format readability, cache validation and durable generation fencing.
Remote publication verification, reader/writer coordination, pins and fail-closed
GC remain authoritative in the portable core. Unknown saves retain/quarantine the
source; unknown commands are observed rather than blindly replayed. There is no
absolute zero-loss guarantee: preserve acknowledged data under the stated durable
boundary and expose unavailable unpublished changes explicitly.

No default switch, client staging/production cutover, npm publication, snapshots,
cross-owner reuse, desktop runtime installation/reconfiguration or subagents.
Public source/docs/commits stay generic. Existing experiments, protected fixtures,
client dirty files and their funds remain untouched. Do not rewrite the controller
or introduce a mandatory daemon merely to manufacture a language speed comparison.

## Finite implementation and acceptance matrix

| Gate                      | Required result                                                                                                                                                                                      | Status                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Contract audit            | Map existing actions, limits, durable records and integration points; mark unsupported experimental paths explicitly                                                                                 | Initial action/state/bundle map complete                                                         |
| Native implementation     | Buildable Rust binary; bounded parsing/I/O, fencing, filesystem/archive/import/cache, execution/output/cancel and interactive paths; no Python fallback for measured operations                      | Native actions and provider file transport implemented; installed proof pending                  |
| Modular selection         | Explicit backend/binary identity, immutable bootstrap receipts, Boat/SSH transport integration and packaged executable; Python default unchanged                                                     | Opt-in Boat/SSH identity, installer and optional package exports implemented; live proof pending |
| Targeted conformance      | Differential protocol/outcome tests, cross-language archive restore, bytes/modes/symlink/hardlink oracle; restart/ack loss/stale fence/partial transfer/corruption/cleanup checks for changed paths  | Local primitive and Python interoperability evidence only; full runtime gate open                |
| Matched benchmark         | Two fresh host pairs, reversed order, five timed cycles per backend per pair (ten per backend overall), plus one replacement per backend; frozen equal image/resources/storage/durability boundaries | Open                                                                                             |
| Honest report and cleanup | Latency, startup, save/readiness/whole cycle, CPU/RSS, bytes/requests, failures and owned absence; report mixed or negative results without further matrix expansion                                 | Open                                                                                             |
| Publication               | Coherent main milestone and exact-SHA CI after authorized publication; concise implementation/benchmark documentation                                                                                | Open                                                                                             |

Implement coherently before broad hosted qualification. Run affected local checks,
freeze artifacts, then run the single planned hosted matrix. Preserve failed
attempts and rerun only an affected failure after a concrete fix. Do not repeatedly
retest unchanged storage/GC/core behavior or chase a predetermined speed target.
If a concrete missing contract is discovered, record it within this matrix rather
than quietly reducing the advertised backend. Unsupported paths cannot silently
fall back to Python and still be called Rust parity.

## Budget and recovery context

On November 3 the user approved **a separate additional $3**, existing Boat wallet
only, no top-up: at most eight small one-hour hosts (four matched hosts, two source-
deleted replacements, two failure reserves). No minimum warm fleet or snapshot.
Conservative reservation at $0.07/start plus $0.036/hour is $0.848 for all eight;
account for actual size-weighted usage, included credits, wallet debits and start
fees separately. Request further authorization before exceeding either cap.

Repository `/home/frtn/work/2026/jetski`, branch main. Frozen initial Python
reference `8bb303f46c78c41d9a68f814953a96fa12467adc`; previous full CI passed seven
jobs. Host Python/native assets unchanged since the qualified baseline. Existing
Rust 1.97.1/Cargo 1.97.1 are available; no toolchain installation is needed.
Private plans, budget, IDs, receipts and failures live under the operator QA state
`rust-host-20261103`; the separate hosted comparison is now running.
Its private budget journal is authoritative for admitted/observed/retired hosts.

Current work: native protocol/fence/frames, trusted supervisor/account/map checks,
Podman lifecycle, command worker/output/cancellation and terminal input are implemented.
Checkpoint capture/import/cache and binary transfer/export now preserve staged
publication, lost-ACK replay, corruption rejection and release-gated cache reuse.
Capture encoding/frame geometry is journaled before encoding. Native stream broker
and deadline-bounded JSON/binary control entrypoints now join the components.
Combined cached-resume, quiesce/finalize/release/purge actions are implemented;
release reads its already-locked state rather than reacquiring the fence.

The local candidate passes **58 Rust tests, 282 TypeScript tests and three
native-installer tests**, plus build/typecheck/lint/clippy. New source provides
explicit Boat/SSH backend selection, pre-bootstrap native intent, a pinned binary
installer and protected native installation checks. Controller restart cannot
change a host's backend/hash; the installer rejects existing Python installs.
Default Python host module bytes/config remain unchanged. Package checks include
the optional adapter/loader/installer and exclude native build output.

The first reference host has published a verified seed checkpoint. Local GNU-static compilation proves the source builds;
the distributable/hosted candidate uses a separate **static musl CI artifact** with
source/SHA manifest and dependency/compiler notices. No musl target or runtime is
installed on the operator's desktop. Native `status` must attest the selected hash.
Local fixture evidence does not prove installed Podman, live interactive behavior
or physical-host replacement. Map: [contract](../../host-rust/contract.md).

## Next actions

1. Candidate `9c29eff` passes all eight exact-SHA CI jobs. The first live native
   host exposed an installer omission: its fixed slot directory was not prepared
   before readiness. No assignment/data was admitted; read-only proof and failed
   setup evidence are preserved. The installer now prepares the private slot;
   publish that affected fix and replace the unassigned test host within reserves.
2. Observe the existing four-arm run rather than duplicating it. Ten timed cycles
   per backend, native live interactive checks outside timed samples, and one
   source-deleted replacement per backend remain the finite hosted gates. Preserve
   actual failures and source bytes on uncertainty; fix/rerun only affected work.
3. Execute the matched comparison, live native interactive/failure checks and
   source-deleted replacements, then clean owned resources and publish the honest
   consolidated report/recommendation. Do not chase a predetermined speed result.
