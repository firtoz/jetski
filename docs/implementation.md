# Implementation and qualification

## Objective

Build an independent MIT-licensed public `firtoz/jetski` repository: portable
TypeScript core/SDK, optional Node HTTP server and thin CLI for durable sandboxes
on reusable compute. Clean history; generic public source/docs/examples/fixtures
and commit messages. Workload integrations remain client responsibilities.

## Approved scope and constraints

Host providers: Boat allocation and explicitly adopted SSH Linux hosts. Initial
platform Linux x86-64. Runtime: rootless Podman; one active assignment per host,
no cross-owner reuse. Default zero warm minimum, demand creation, ten-minute idle
retention, one host per owner with excess queued; configurable owner capacity.
Boat lifetime bounded to one hour. SSH hosts are operator-owned and never powered
off or deleted. Bootstrap validates namespaces, cgroups, subordinate IDs,
filesystem and runtime versions. Images require operator-approved OCI digests.
Example image is generic Linux. EC2, Daytona, Cloudflare Containers, concurrent
placement and Firecracker are extension targets only; managed sandboxes require
contracts distinct from installable machine hosts.

Boundaries: host provider, runtime, immutable streaming checkpoint store,
transactional state, durable scheduler, authenticated encrypted transport,
identity/policy and structured event sink. Core cannot depend on filesystem,
provider secrets or framework bindings. Separate package subpath exports prevent
SDK/core imports loading database/SSH/provider implementations. Ordinary Python
host modules may be extracted only after provenance review.

API v1 covers sandbox create/inspect/list/stop/resume/delete; command start/status/
cancel and resumable output cursors; bounded file streams; checkpoint inspect/
create/pins/restore; terminals, previews, TCP forwarding; capabilities and durable
operation status. Stable operation identities and persisted outcomes prevent
blind replay after uncertain command completion. Versioned host protocol fences
stale generations; credentials stay outside containers.

Checkpoint quiesces execution and leaves the sandbox stopped. Stop additionally
releases the host only after durable verified publication. Resume builds a fresh
writable sandbox. Failed/uncertain saves preserve and quarantine source. Persistent
paths initially /workspace and /home/sandbox; no kernel/RAM/entire-host snapshots.
Local storage is on control-plane disk, not executor; remote S3-compatible storage
(including qualified R2) protects against control-plane disk loss.

Incremental independently compressed immutable frames; bounded reconstruction;
exact bytes, modes, symlinks and hardlinks. Local cache reuse only after verified
durable publication. Readers/writers and retained roots coordinate transactionally;
stale generations rejected. GC requires complete reachability, minimum 24-hour
grace, fail-closed ambiguity, durable journals, explicit pins and no silent expiry
of acknowledged history. No cross-owner deduplication. Adapters must pass failure
and consistency contracts; plugins cannot bypass verification/fencing.

Standalone: SQLite state, durable worker loop, bearer owner authentication,
public-key SSH gateway (never an outer-host shell), PTY stdin/resize/signals,
authenticated HTTP/WebSocket previews and TCP tunnels. CLI forwarding binds
loopback. Embedded clients inject state/scheduling/transports without a mandatory
standalone service. SDK/core remain portable.

Integrate a downstream client only after independent qualification, using pinned
commit/release dependencies, starting with new staging workspaces. Legacy readers
and migration stay client-side; idle adoption follows independent restore proof.
One authoritative backend per workspace; rollback must preserve acknowledged
checkpoints and prevent competing writers. No production cutover, npm publication,
or public hosted-compute service in this implementation.

## Acceptance matrix

| Gate                       | Required evidence                                                                                                    | Status                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Independent repository     | MIT, clean history, provenance, CI, exports, executable generic example                                              | In progress                        |
| Independent vertical slice | SQLite/local storage, SSH-adopted Linux, Podman, server/SDK/CLI shell+file checkpoint/recovery                       | Verified SSH/local; CI 41217621891 |
| Boat and S3                | Both host/store adapters pass contracts; R2 and fresh-host recovery                                                  | Open                               |
| Pool lifecycle             | owner exclusivity, one assignment, bounded queue/idle/expiry, restart/fencing                                        | Open                               |
| Durable execution          | replay/lost ACK/restart/uncertainty/cancel/resumable streams                                                         | Open                               |
| Filesystem fidelity        | bytes/modes/symlink/hardlink/Unicode/empty/rename/delete/large/partial transfer                                      | Open                               |
| Incremental checkpoints    | cold/cache hit/miss/corruption/changed frames/fresh replacement                                                      | Open                               |
| Safe GC                    | reader/writer/publication races, complete paginated listings, corrupt metadata, repeated/failed deletion, real grace | Open                               |
| Security                   | cross-owner denial, secrets isolation, process/listener/mount cleanup, unsupported capability rejection              | Open                               |
| Interactive transports     | SSH auth, PTY resize/signals, streams, HTTP/WS previews, binary TCP                                                  | Open                               |
| Server recovery            | SQLite atomicity, restart pending operations, scheduler recovery, local/S3 parity                                    | Open                               |
| Staging integration        | independent client workflow and replacement recovery, pinned dependency                                              | Open                               |
| Matched benchmark          | same durability boundary; starts/sessions/readiness/save/bytes/requests/idle compute, failures retained              | Open                               |
| Release                    | main CI green, test resources cleaned, limitations documented                                                        | Open                               |

## Operational boundaries

Do not alter the separate real-grace experiment scheduled November 1, 2026 at
12:20 UTC: its clock, checkpoint references, active generation and recovery budget
are reserved. New paid-host experiments require a separately approved allowance.
No infrastructure purchases, wallet top-ups, new snapshots, or operator desktop
modifications. Local qualification first. Keep private operational receipts outside
this repository. Public content must not name downstream private applications or
workload-specific products.

## Latest continuation status

Verified source: **dea458a79213019c512d1029542d3911b8133c6e**, CI **41219691405**,
all four jobs successful; watcher 12089 terminated with exit 0. Local build,
typecheck, Biome, Ruff and all **80 unit tests** pass (38 TypeScript, 42 Python).
Real API logs confirm checkpointHistoryAndReplaySafePins=true alongside the prior
upload, expiry, queue, shutdown, output retention and replacement recovery checks.
No active CI work remains; disposable hosts/listeners were cleaned by the fixtures.

The independent SSH/Podman + SQLite/local-store vertical slice now executes commands,
streams bounded files through SDK helpers, admits resumable uploads, checkpoints,
stops and reconstructs a fresh container. Upload publication has immutable identity,
chunk fsync receipts, atomic rename and an uncertainty-preserving shutdown barrier.
Completed outcomes survive generation changes without contacting the old host.
Tests cover lost import, checkpoint-store, output-store and file-write acknowledgements.
Replacement qualification uses a fresh container on the same physical SSH host;
fresh physical-host/remote-store recovery is still unqualified.

Checkpoint history/pins are exposed through core, API, SDK and CLI. Pages separate
filesystem snapshots from retained command outputs. Pin changes and operation outcomes
commit atomically; replay cannot undo a later change, including across generation
advance. Owner denial, transaction rollback and pin-protected retirement are tested.
Inspection is metadata-only, not a storage-integrity audit. Unpinning does not retire
history or enable collection. Public retirement remains pending. The synthetic test's initial invalid zero-expanded-byte frame was corrected
without weakening manifest validation; the passing fixture preserves the strict check.

Current bounds: file chunks 256 KiB, uploads 64 MiB/file and 64 identities/assignment,
listings 256 entries/page with a 10,000-entry scan ceiling, checkpoint pages 100 roots,
and 128 named pins/root. Live file reads are not snapshots; file publication is host-local
until checkpointed. Writes atomically replace directory entries, not hardlink groups.
Expiry testing uses an injected controller clock, not provider forced termination.

Historical selection continuation: resume now accepts an explicit retained filesystem
checkpoint, with immutable operation selection and an internal lifecycle reference.
The reference blocks retirement/collection while queued or uncertain, survives the
generation change and cannot be removed through user pin APIs. It is released only
after runtime readiness or atomic queued cancellation. Missing/non-filesystem roots
and conflicting operation replays fail before allocation. Unit tests verify these
cases and preservation of newer history. All 75 tests, build/typecheck and linters
pass. Real API qualification now writes different newer bytes, saves them, selects
an older root, and checks older bytes plus retained newer history and reference cleanup.
CI **41218243748** passed all four jobs; API logs confirm historicalCheckpointSelection=true
and preserve all previous recovery checks. Source **2f6e706024dc5ea5352bffbf76d2258fb3c8933a**
is verified; watcher 63038 exited 0 and disposable resources were cleaned. This remains
same-host container replacement, not cloud-host qualification.

S3 continuation: added an explicitly exported Node adapter using pinned AWS SDK v3
3.1161.0 and optional standalone configuration with explicit credential environment
names and HTTPS. Immutable reservation markers survive deletion. Upload/read bounds,
full SHA-256 verification and fail-closed pagination protect the core's publication
contract. Actual SDK HTTP-fixture tests cover conditional headers, concurrent puts,
reservation/data ACK loss, corruption, namespace isolation and pagination failures.
All 77 unit tests, build/typecheck and linters pass; npm audit reports zero findings.
See docs/storage.md for provenance, upstream contract sources and limitations.
These are protocol-fixture tests, not live S3/R2 conformance or cloud recovery proof.
Live storage qualification and complete orphan GC remain open. No cloud requests or
paid resources were used. CI **41219011312** passed all four jobs at
**e2dc5e8dcc40e442b28d974bca55993d9421b733**, including SDK HTTP-fixture tests and
the full existing SSH/local-store API recovery fixture. Watcher 33852 exited 0;
disposable resources were cleaned. Live S3/R2 remains unqualified.

Storage conformance continuation: added one exported functional runner shared by
local storage and the S3 adapter through the actual SDK HTTP fixture. It checks
binary/range/empty reads, isolation, immutable and concurrent creation, interrupted
and corrupt input, fresh-client reopening, exact scoped inventory, idempotent deletion
and permanent identity reservation. Cleanup only targets explicitly admitted fresh
fixture addresses and records failure; reservation markers intentionally remain.
A deliberately broken adapter test proves failure reporting and cleanup. The generic
executable example defaults to temporary local storage and accepts explicit remote
configuration without provisioning resources. Adapter calls are not billable-request
counts; elapsed time is not a matched benchmark. All 80 unit tests pass, plus
build/typecheck/linters. No live R2 or paid-host operations occurred; live provider
qualification remains open. The standalone local example passed all 12 contract checks
with 6 fixture identities and verified blob cleanup (20 ms diagnostic duration, not
a performance comparison). Cleanup-failure tests retain failed object addresses and
still attempt every deletion. Remote examples force single-entry pages. CI41219691405
passed all four jobs; the standalone local example passed all twelve checks with
verified cleanup in CI as well.

Next: observe exact-SHA CI, then qualify S3/R2 adapter parity and replacement recovery,
then complete remaining interactive/API scope and machine-provider adapters;
qualify unresolved assignment deletion, orphan-reader/multi-controller recovery;
finish complete safe GC, Boat/S3/R2 adapters, fresh physical-host recovery, downstream
staging integration and matched benchmarks. Keep every original acceptance gate.
No paid host resources, original recovery reservation or separate GC experiment state
was touched. No production cutover or publication beyond the authorized public source.
Full release acceptance remains unproven; the goal stays active.

## Current evidence and next actions

2026-10-31: initialized empty main branch; no historical source imported. No host
allocated, workload executed, checkpoint deleted or paid experiment initiated.
Implemented portable operation journal, SQLite transactional adapter, isolated SDK
entry point, immutable local object storage and an initial checkpoint registry.
Eight tests pass on Node 24.22.1: restart/lost ACK, identity conflict, stale fencing,
transaction rollback and escaped-handle rejection, owner/path isolation, upload
integrity, tombstone identity reuse, range reads, retained-root verification,
reader/writer exclusion and simulated minimum-grace collection. Build and Biome
lint pass. npm audit reports zero dependency vulnerabilities. No third-party source
has been copied. The author-owned generation fence was reviewed and adapted into
host/fence.py as ordinary Python, retaining attribution in NOTICE and its header.
Four Python tests pass: close-before-claim/restart, trusted cleanup/publication
release gate, owner isolation/generation gaps, and symlink-state rejection. Further
host runtime and filesystem extraction still needs provenance review.

These are foundation tests, not adapter or hosted qualification. The registry's
initial collector handles known retired frames only; complete orphan enumeration,
pagination, resumable deletion receipts, runtime schema validation and bounded
registry growth remain open. Core registry generation is not yet integrated with
host fencing. No lifecycle service or host runtime is wired. The SDK currently
exposes operation lookup plus a generic authenticated request. Do not advertise
v1 API completion or filesystem checkpoint fidelity yet.

Next: finish storage/registry fault contracts; add the independent server/CLI and
SSH/Podman vertical slice, retaining normal Python host modules where justified.
The operator desktop has not been modified; supported Node was obtained via an
isolated npm exec tool cache, without changing the system runtime. No cloud spend.
No adapter or performance claims qualified yet.

At each continuation read this file, inspect actual git/check state, update closed
gates with evidence, and pursue all remaining gates. Full implementation is the
objective; scaffolding alone does not satisfy acceptance.


Repository published: https://github.com/firtoz/jetski, initial commit
928c24fd42638f42d15b39dc190716ee6838643c. CI run 41206273440 completed successfully for that commit. Public publication is
an initial implementation checkpoint, not a qualified release.


2026-10-31 continuation: added ordinary Python archive and independent-frame
compression modules, plus rootless Podman create/quiesce/remove lifecycle adapter.
Sixteen Python unit tests pass, including independent tree comparison across bytes,
modes, hardlinks, Unicode and external/dangling symlink targets; rename/delete,
malformed archives, partial captures and one-frame edits. Runtime unit tests verify
stale/closed leases, quarantine on uncertain creation, approved image digests and
observed stop/removal. Runtime networking is currently disabled; full execution,
transport, bootstrap and server integration remain open. Rootless runtime CI now
uses a disposable runner, resolves an explicit fixture image to a digest, and tests
source-deleted filesystem recovery into a fresh container. Its result is pending;
this is not a replacement-host or remote-store test. No desktop runtime was used.

First rootless CI run 41206794034 failed after successful container startup because
the fixture attempted to create a hardlink across two bind mounts (Linux EXDEV).
The runtime fixture now creates hardlinks within /workspace; independent archive
tests still prove preservation of pre-existing cross-root hardlinks. Separate bind
mounts retain normal Linux mount-boundary link semantics. This failure is retained
in CI; it is not a checkpoint or Podman-start success claim.


Current continuation evidence: CI 41206907765 passed on commit
287a9e4f47f5f31496e2b377c7af1e5940ab9f5f. The real rootless Podman job reports
filesystemExact=true, sourceDeleted=true, replacementContainer=true and
replacementHost=false, with cgroup v2 and six independently compared entries.
Fixture image digest is recorded in the CI output. Both workload containers were
removed and absence checked; host-wide process/mount cleanup remains a separate
open qualification gate. The initial failed run remains preserved above.

Added the Node SSH transport and adopted-host provider behind separate exports.
SSH requires explicit keys and known-hosts, strict host-key checking, no ambient
agent/config/forwarding, bounded requests/output/time and a fixed host-control
entry point. Transport failures represent uncertain remote completion. Adoption
and retirement use durable allocation identities; owner bindings survive release,
and stale retire calls cannot free a subsequent allocation. Two additional unit
tests pass (ten TypeScript tests total). These do not qualify a live SSH transport:
installed host-control dispatch/bootstrap and an encrypted end-to-end test remain
next, followed by the standalone server/SDK/CLI vertical slice. The provider's
capabilities describe its intended runtime requirement, not observed host readiness.

Progress classification: this continuation implemented source and generated real
rootless recovery evidence. No paid provider requests, original client changes,
GC experiment changes or desktop workload execution occurred.

2026-10-31 bootstrap continuation: added root-only host configuration, dedicated
rootless account validation, bounded subprocess supervision, capability preflight
and SSH protocol dispatch. Host control uses one physical-host fence, checks
machine/pool identity, supports create/inspect/quiesce/capture/remove, and rejects
unknown actions. Creation replay returns an existing matching receipt; changed
configuration conflicts. Bootstrap requires preinstalled prerequisites, explicit
image digests and no existing assignment; it does not install system packages.
Twenty Python unit tests now pass, including malformed protocol, physical fencing,
create replay and subprocess output/time limits. Ten TypeScript tests pass.
A new disposable CI job exercises bootstrap and real encrypted SSH control with a
forced command, correct/wrong host keys and stale-generation rejection. Its result
must be observed before claiming SSH qualification. No desktop host was modified.
Full execute/PTY/network/transfer handlers and standalone lifecycle remain open.

SSH CI run 41207434974 stopped at the unsafe-install-path guard before bootstrap
completion. The disposable fixture now reports ancestor modes and makes /opt
root-owned/non-writable by other users; production checks remain strict. Exact
failure path is now included in the bounded bootstrap diagnostic.

Added bounded checkpoint range reads over host control and portable incremental
publication into the checkpoint registry. Captured manifests validate extents,
counts, hashes and bounds; immutable objects are read back before root publication.
Only verified matching frames from a retained previous root are reused. Failed
transfers retain writer exclusion; repeated successful operation IDs observe the
persisted root rather than rereading a lost source. Twelve TypeScript tests pass,
including changed-frame upload, source-independent reconstruction and failed-read
quarantine. The SSH fixture now attempts real verified local publication over the
encrypted control transport; qualification remains pending its CI result.

## Current verified handoff

CI **41207766494** passed on **8480e8f30bd704b5b0630683e470264bc1c39d10**:
all TypeScript/Python checks, real rootless container replacement, and real SSH
bootstrap/control/local-publication jobs. Logs confirm Podman 4.9.3, cgroup v2,
overlay storage, create replay, stale fencing and verified local publication.
Twelve TypeScript and twenty-one Python unit tests pass. The SSH transfer fixture
currently captures two empty persistent roots; nonempty exact filesystem recovery
is independently exercised by the real rootless runtime job and archive tests.
Do not conflate these into a complete end-to-end server or fresh-host test.

CI independently confirmed `/opt` was mode 0777 on its disposable runner; only the
CI fixture fixes that ancestor. Production bootstrap continues to reject it. Run
41207717862 preserved the missing-runuser failure caused by a sanitized PATH;
supervisor tool resolution now uses explicit system directories and a regression
test. No original client or GC-test state was touched and no Boat budget was used.

Next discriminating work: implement durable execution/output receipts and command
reconnection, then the lifecycle service and standalone server/CLI. Killing a local
SSH/Podman client is not proof that a remote command or its descendants stopped;
qualification must observe workload cleanup before release. Finish authenticated
checkpoint import/reconstruction and source-deleted recovery through the transport,
then S3/Boat adapters, interactive gateways, full GC contracts and downstream
staging adoption. All original acceptance gates remain in scope. The current code
is an implementation checkpoint, not a v1 release. No live operations remain from
this continuation; CI jobs are terminal and disposable listeners/containers cleaned
within their fixtures. Check `gh run list` for the documentation commit's latest CI.

2026-10-31 execution continuation: added host command admission, detached workers,
terminal receipts and bounded binary output cursors. Identity replay observes the
existing command; even lost worker-launch acknowledgement does not spawn another.
Host release rejects unresolved command receipts. Worker output is bounded and
quiescence is observed after time/output limits. Cancellation currently stops the
whole assignment; precise per-command signals and PTYs are still required for v1.
Six new unit tests cover replay/restart, lost launch ACK, binary cursors, stale
leases, release exclusion and invalid specs (27 Python, 12 TypeScript tests).
The SSH CI fixture now exercises real commands, reconnecting output, duplicate
prevention, cancellation and a nonempty checkpoint. Await its actual CI outcome;
source-only assertions do not qualify execution. Prior documentation CI must be
checked independently. This continuation has made implementation progress; no
paid hosts, desktop runtime changes or existing GC experiment changes occurred.

Execution CI **41208335388** passed on **f4d9bee69e73ba4698a0cdbc9cd70efeba32cbd5**:
real SSH command admission/replay, binary output cursor continuation, assignment
cancellation and nonempty capture/local publication. The earlier 41208293440 run
preserves a missing installed worker-module failure; the installation-bundle test
now imports modules in isolated Python without access to the source checkout.

Checkpoint import now journals byte offsets, verifies chunk identities and the
complete archive digest, rejects conflicting replays, and restores only into a
fresh assignment before execution admission. A crash after bytes reach disk but
before offset acknowledgement is covered by a recovery test. Trusted control
release checks matching publication receipt, runtime absence and resolved commands;
source purge requires that release. The private host-control protocol must never
be exposed as an unfiltered public API: publication assertions are controller-owned.
Thirty-one Python tests pass; twelve TypeScript tests pass. Typecheck now covers
examples and tests as well as library code. The real SSH fixture now deletes the
source only after verified publication, imports from the independent local store,
executes against the restored tree and compares the next checkpoint SHA exactly.
Await CI before claiming that combined restore path qualified. Cancellation still
stops the full assignment; fine-grained signals/PTYs remain open.

Verified combined path: **979bc1cfe1eb9393ef194a16b0ddcc8a60d9eed6**, CI
**41208777287**, all three jobs successful. Real SSH control reports durable
execution, binary output reconnection, assignment cancellation, verified local
publication, source-deleted transport recovery and identical repeated checkpoint
SHA. This is same-physical-host/new-assignment recovery from independent local
storage, not a replacement-host or S3/Boat qualification. Standalone server/CLI,
transactional pooling/scheduling, precise signals/PTYs/networking, S3/Boat, complete
GC and downstream staging remain open. No live watcher remains (91700 terminal0),
no Boat spending or original experiment changes. Next continuation should build
the lifecycle coordinator and standalone API over these tested transport primitives.


Lifecycle/API continuation: added transactional owner-bound placement, persisted
FIFO tickets and allocation reservations, generation continuity across SSH host
re-adoption, quarantine capacity retention and stale-release receipts. Three pool
tests cover concurrency, queued excess demand, owner isolation, idle retirement,
expiry and lost release acknowledgement. Added the portable sandbox manager,
optional bearer-authenticated loopback HTTP server, standalone worker, thin CLI,
operator configuration example, generic digest-pinned Linux Containerfile and
OpenAPI for implemented routes. Server tests prove owner scoping and progress with
no browser polling; unknown create effects retain/quarantine rather than rerun.
Seventeen TypeScript and thirty-one Python tests pass locally, plus build,
expanded typecheck and both linters. A real API/SDK/CLI CI fixture is now added
alongside the direct SSH lifecycle fixture; its result remains pending.

This is not the completed standalone vertical slice: stop/resume/delete and
checkpoint HTTP endpoints, autonomous recovery of every interrupted lifecycle
stage, durable command output beyond host retirement, full scheduling/expiry
maintenance and interactive gateways remain open. The manager currently preserves
unknown operations in quarantine instead of automatically resuming them. Existing
transport-level full save/import/recovery evidence remains valid and separate.
No Boat spending, desktop workload or original GC-experiment change occurred.


Verified standalone entry point: CI **41209889581** passed on
**6af4a9ba929eee26b8b71a2969206e8ded0f525f**. The real API fixture reports owner
isolation, server-owned progress, command execution, SDK and CLI success, and
explicitly reports completeLifecycle=false. Direct SSH source-deleted recovery
and repeated-checkpoint equality also continue to pass. No paid host was used.

Follow-up recovery now observes a fenced existing running container after a lost
create ACK and finalizes its original operation after controller restart, without
another allocation or create RPC. A regression test asserts the recovered sandbox
is running and both physical allocation/create counts remain one. Unobserved or
ambiguous effects still remain quarantined; full interrupted-stage recovery is
not yet complete. API fixture cleanup closes its local server even when remote
cleanup fails, while surfacing that failure. Next: stop/checkpoint/resume/delete
coordinator paths and durable output retention, then full standalone recovery.

Latest verified source: **994d5bf2f6f1cfe4eb99acc684b05c154884c887**, CI
**41210175537**, all four jobs successful (unit/build/lint, rootless runtime,
direct SSH recovery, and real standalone API/SDK/CLI). Watcher 55071 terminal0.
This continuation made implementation and qualification progress. Full acceptance
is still unproven: the API fixture intentionally covers create/execute only.
Next continuation should implement durable stop/checkpoint/resume/delete through
the coordinator, retaining command outcomes/output before releasing a host. Keep
all earlier gates and operational constraints; no new budget has been approved.

Command retention continuation: controller admission now persists each command's
identity, original assignment and specification before dispatch. Repeated starts
observe that identity instead of redispatching, including after a lost ACK or
controller restart. A portable command-output store publishes verified immutable
binary segments and terminal outcomes through the retained-root registry; readers
verify hashes and hold reader admissions. Failed saves preserve writer exclusion.
Nineteen TypeScript and thirty-one Python tests pass, including multi-frame binary
cursor recovery, source-unavailable replay, corrupt-object rejection, owner denial,
conflicting outcomes and interrupted publication. Build/typecheck/Biome/Ruff pass.
The real API fixture now retains command output and reads it with its host-control
transport disabled; CI qualification remains pending. This does not yet prove
full host retirement or automatic lifecycle retention: stop/checkpoint/resume/delete
remain the next coordinator work, and interrupted retention still quarantines
rather than automatically retries. No paid resources or existing GC state touched.

Verified output-retention source: **5cda744d93eec3b0e08ba73ff48517a636f1bc84**,
CI **41210949349**, all four jobs passed; watcher 80494 terminal0. Real standalone
API output/status remain available after disabling host-control transport. This is
transport-unavailable evidence, not yet full lifecycle host-retirement recovery.
Next: persist stop/checkpoint phases, close admission atomically, resolve command
receipts and retain output, publish filesystem checkpoint, then release the host;
implement resume with explicit generation transitions and verified import. Keep
all remaining adapter/transport/GC/client/benchmark gates. Goal remains active.

Shutdown continuation: added a persisted controller sequence and HTTP/CLI routes
for checkpoint and stop. Command admission closes atomically with stop admission;
quiescence precedes terminal-output retention and filesystem capture/publication.
Cleanup revalidates published objects; stop removes the container, acknowledges
release, purges the source, then returns the host to the owner's pool. Checkpoint
keeps its stopped assignment. Safe stages reconcile after lost acknowledgements;
failed output/archive publication remains quarantined for explicit recovery.
Three new tests cover publication-before-destruction, interrupted upload exclusion,
release-ACK loss/controller restart, completed-operation replay and warm host reuse.
Twenty-two TypeScript tests, build/typecheck/lint pass. The real API fixture now
attempts durable stop, post-release output access and a new assignment on the same
host; await CI before claiming this path qualified. Resume, delete, controller
multi-writer qualification and automatic interrupted-upload recovery remain open,
along with all earlier full-release gates. No paid host or prior GC state touched.

Host cleanup follow-up: removal now observes container absence before retrying rm,
so a lost removal acknowledgement can finish its existing receipt without another
removal effect. Two regression tests cover lost ACK and inspection errors that
must not authorize release. Thirty-three Python tests and Ruff/Biome pass locally.

Verified shutdown: **9fb532d32dfac2e31443465c9d37c892b2bcca5b**, CI
**41211390211**, all four jobs passed; watcher 8118 terminal0. The real API log
reports durableStop=true and warmHostReuse=true, while completeLifecycle=false.
Latest verified source **b57dedf647a262125b3b75057a95fe1b99120e74**, CI
**41211488582**, all four jobs passed; watcher 91102 terminal0. Twenty-two
TypeScript plus thirty-three Python tests pass (55 total). No live CI watchers or
paid hosts remain from this turn. Disposable fixtures run their cleanup steps.
Next: resume from the published checkpoint into a fresh assignment, with explicit
registry/operation generation advancement and stable placement operation IDs;
qualify API source-deleted recovery and repeated saves, then deletion/expiry and
all remaining transport/adapter/GC/client/benchmark gates. Shutdown currently
quarantines partial output/archive transfers instead of automatically repairing
writer admissions; this is a known incomplete recovery path, not release completion.

Resume continuation: added atomic checkpoint/operation generation advancement,
stable placement identities distinct from initial creation, portable retained-root
restore and HTTP/CLI resume routes. Resume of a stopped released sandbox creates a
fresh assignment and imports verified frames before workload admission; old command
outcomes/output remain readable from retained roots. The queue repairs admission
across restart. Tests cover repeated resume without redispatch/import, command-ID
conflict rollback of both generations, active-reader exclusion, stale writers and
another stop/save after resume. Twenty-two TypeScript and thirty-three Python tests,
build/typecheck/Biome/Ruff pass. The real API fixture now attempts source-deleted
resume, restored-file validation and equal archive hashes after repeated save;
await CI before claiming that end-to-end path qualified.
Direct resume from a checkpoint that still holds its host is not implemented yet
(stop first); interrupted import recovery still quarantines unobserved effects.
Delete/idle-expiry orchestration, all interactive transports, Boat/S3 qualification,
complete GC, client staging and matched benchmarks remain open. No paid host or
existing GC experiment state touched.

Verified resume source: **d420c1a0c6eeba37934fb5d89e1b5d4f0887a03d**, CI
**41211881089**, all four jobs passed; watcher 37714 terminal0. Real API log
confirms apiSourceDeletedRestore=true and repeatedCheckpointEqual=true, alongside
warm host reuse and durable stop. This qualifies same-physical-host/fresh-assignment
restore through the standalone API, not fresh-host or cloud-store replacement.
The fixture correctly leaves completeLifecycle=false. Next: direct resume from a
held checkpoint, interrupted import/controller recovery, delete and idle-expiry
orchestration; then the remaining provider/storage/transport/GC/client qualification
and matched benchmarks. Keep the full acceptance matrix and budget boundaries.
No paid resources or original experiment changes occurred in this continuation.

Idle-retirement continuation: wired the durable pool's retirement receipts into
server-owned reconciliation. Released idle allocations retire at the ten-minute
boundary or allocation expiry; unknown retirement results retain their capacity
until retry succeeds. No-demand pools stay empty, and later SSH re-adoption keeps
owner/fence/generation continuity. Added injectable controller clock for bounded
qualification. Tests cover the idle boundary, active-assignment exclusion, lost
retirement ACK/controller restart, no duplicate completion, zero replenishment and
next-generation demand. Existing SSH contract proves retirement sends no poweroff
or delete command. The real API fixture now advances only its injected controller
clock after stop, observes allocation release and checks that SSH host control is
still healthy. Await CI before claiming that combined behavior qualified.
All 55 unit tests, build/typecheck/Biome/Ruff pass locally. Active-host pre-expiry
drain is still incomplete and must not be inferred from idle retirement. Direct
held-checkpoint resume, interrupted import/save recovery, delete and all previously
listed release gates remain open. No original GC clock/state or budget was touched.

Verified idle-retirement source: **32f13a73628e8859023a7dbccfdaa21732fcc2d7**,
CI **41212227089**, all four jobs passed; watcher 11897 terminal0. Real API log
reports idleRetirementWithoutPowerOff=true after the complete source-deleted
stop/resume/repeated-save fixture. The elapsed-time boundary uses an injected
controller clock, not a real ten-minute soak or any altered provider/GC clock.
All 55 unit tests remain green. Next prioritize held-checkpoint resume and durable
sandbox deletion, then interrupted-stage recovery and active-host pre-expiry drain;
retain every remaining adapter/transport/GC/client/benchmark acceptance gate.
No live test handles, paid hosts, or prior experiment modifications remain from
this continuation. Goal is active and release completeness remains unproven.

Deletion continuation: added DELETE API/CLI and durable deleted-state semantics.
Assigned running/stopped sandboxes use the same verified publication, container
cleanup, release and source-purge sequence before deletion succeeds. Released
sandboxes atomically commit their deleted state and operation outcome. Deleted
identities reject new execution and resume while retaining all acknowledged
checkpoint/command history. Tests cover controller restart, replay without host
effects, owner denial, retained roots and both assigned/released deletion paths.
Shutdown admission now commits its operation and lifecycle record atomically,
avoiding orphan queued operations on rejected requests. All 55 unit tests,
build/typecheck/Biome pass; the real API fixture now checks released deletion and
retained history. Await CI qualification. Queued/starting/quarantined deletion is
still rejected pending resolved placement; full deletion/recovery coverage remains
open, as do held-checkpoint resume and all other listed release gates. No paid
resources or existing GC-test state changed.

Verified deletion source: **f7545811e76865e704f7b55280b391faf56bcda4**, CI
**41212548510**, all four jobs passed; watcher 59967 terminal0. Real API evidence
reports deletedSandboxRetainsHistory=true after source-deleted resume/repeated
save, then successful idle retirement without poweroff. Assigned deletion has
unit-level restart/replay/publication evidence; this CI addition directly exercises
released deletion. Complete lifecycle qualification is still false. Next prioritize
held-checkpoint resume and interruption recovery, then queued/uncertain deletion
and active-host expiry drain; retain the full provider/storage/transport/GC/client
and benchmark scope. No paid allocation or prior experiment state was touched.

Held-checkpoint resume continuation: a single persisted resume intent now reserves
its release dependency atomically with shutdown admission. After verified release,
reconciliation advances both generations and carries only the undispatched resume
operation into fresh placement. A pending-resume marker excludes competing lifecycle
requests across the release/placement boundary. Replays observe the existing intent.
Local tests cover lost release ACK, controller restart, retained source restoration,
competing deletion denial and no repeated import. All 55 unit tests and build,
typecheck/Biome/Ruff pass. The real API fixture now attempts held-checkpoint resume
then deletion of its active assignment, comparing the final checkpoint SHA with
the original and retaining historical output. Await CI before claiming those paths
qualified. Interrupted import/save recovery, queued/uncertain deletion, active-host
expiry drain and all remaining adapter/transport/GC/client/benchmark gates remain.
No paid resources, operator host configuration or original GC experiment changed.

Verified held-resume source: **dacfd5326e9b7bdd87310321e2d5014cf187990b**,
CI **41213006705**, all four jobs successful; watcher 1790 terminal0. Real API log
reports heldCheckpointResume=true and assignedDeletion=true, with identical final
archive SHA and retained command history. This closes the previously missing
held-checkpoint happy path and adds actual-host assigned-deletion evidence. Full
lifecycle qualification remains false because interrupted import/save, queued and
uncertain deletion, active expiry and multi-controller recovery remain open.
Next discriminating work: reconcile interrupted checkpoint imports from observed
host receipts without replaying uncertain execution, then remaining lifecycle gates
and the full storage/provider/interactive/client/benchmark scope. No paid host or
original GC experiment changes; all current test jobs are terminal and cleaned.

Interrupted-import continuation: restore validates host progress and resumes from
its durable byte offset, including a partial compressed frame; extraction-in-progress
continues through the host's fenced finish operation. Each chunk and completion
acknowledgement is checked for identity, extent and phase. Controller reconciliation
continues import only when the exact fenced host reports no runtime creation receipt;
creating/uncertain runtime receipts remain quarantined and are not redispatched.
A multi-chunk binary test loses an acknowledgement, verifies no acknowledged bytes
are resent, compares reconstructed bytes exactly, and rejects invalid progress and
finish receipts. Regression coverage confirms uncertain creation is not repeated.
Twenty-three TypeScript and thirty-three Python tests pass with build/typecheck and
linters. Real API qualification now injects an acknowledgement loss after actual
host import bytes are committed and waits for autonomous recovery; CI is pending.
This does not yet clear reader admissions orphaned by abrupt controller process
loss or recover partial checkpoint uploads. Those, active expiry, unresolved
placement deletion and all provider/storage/interactive/client/benchmark gates
remain in scope. No paid host or original GC experiment state was changed.

Verified interrupted-import source: **e469dc4d5abd931b56549345a961783e9c9e0e90**,
CI **41213437693**, all four jobs successful; watcher 80939 terminal0. Real API
log confirms lostImportAcknowledgementRecovery=true after injecting failure only
after the host committed import bytes. Recovery completed on the existing assignment
and the final checkpoint hash still matched. This is transport-ACK-loss evidence,
not an abrupt-process-kill or multi-controller lease-recovery qualification.
All 56 unit tests pass. Next: durable recovery of interrupted checkpoint publication
and orphan admissions, then unresolved placement cancellation/active expiry; keep
all storage/provider/interactive/client/benchmark gates. No paid hosts or original
GC-test state changes; all current disposable CI jobs are terminal and cleaned.

Interrupted-save continuation: checkpoint frame publication now journals the exact
immutable upload identity before I/O and binds resumptions to the original archive
manifest/generation. Retrying verifies journaled objects and skips committed frames,
including when upload succeeded but its acknowledgement was lost. Writer exclusion
persists across failed attempts; only verified publication clears it and permits
source release. Upload receipts must match the requested identity/extent/hash.
Shutdown now retries the same journaled archive publication while preserving source
quarantine on failure. Tests recover after repeated source-read failures and a lost
store ACK, prove one upload per frame, reject changed operation input and compare
all reconstructed bytes. Twenty-four TypeScript and thirty-three Python tests pass
with build/typecheck/Biome/Ruff. Real API qualification now loses a store ACK after
an actual committed object, then must recover before continuing source-deleted
restore, held resume and deletion. CI is pending. Output-retention recovery and
orphan reader admissions after process death remain incomplete; retain all other
release gates and operational boundaries. No paid hosts or original GC state touched.

Verified resumable-save source: **778f0b802f26bd4b35d51667fe29cf453e756358**,
CI **41213913626**, all four jobs successful; watcher 90765 terminal0. Real API
log confirms lostCheckpointStoreAcknowledgementRecovery=true and subsequent import
ACK recovery, with identical final archive hashes. This verifies local-store upload
ACK-loss recovery, not S3 consistency or abrupt process-kill/multi-controller
qualification. All 57 unit tests pass. Next: output-retention journaling and orphan
reader recovery, unresolved placement cancellation and active expiry, then complete
storage/provider/interactive/client/benchmark qualification. Full acceptance remains
unproven. No paid allocation or prior GC-test changes; test jobs terminal/cleaned.

Output-retention recovery continuation: command output now uses a durable stream
journal bound to the command's terminal outcome and generation. Each binary segment
records its channel cursor, digest, terminal marker and immutable object identity
before upload. Retrying verifies/reuses committed segments without rereading the
host, rejects changed segment content, and preserves writer exclusion until full
publication. Shutdown can now recover output retention instead of permanently
blocking its output stage. Tests cover interrupted reads, lost upload ACK across a
new output-store instance, one upload/no reread for committed stdout, exact binary
reconstruction and retained-source independence. All 57 unit tests, build/typecheck
and linters pass. Real API qualification now injects a committed output-upload ACK
loss in addition to checkpoint/import ACK loss, requiring recovery before its next
checkpoint and deletion. Await CI. Orphan reader/controller-lease recovery, unresolved
placement cancellation, active expiry and the remaining full release gates stay
open. No paid resources or original GC experiment state changed.

Verified output-journal source: **c49c7cd62719c935a50be8eb7e4cb0425bf128cf**,
CI **41214348523**, all four jobs successful; watcher 91948 terminal0. Real API
log confirms lostOutputStoreAcknowledgementRecovery=true along with checkpoint and
import ACK recovery, equal archive hashes, assigned deletion and retained history.
All 57 unit tests pass. These tests qualify acknowledgement-loss recovery with local
storage, not abrupt process death or S3/provider parity. Next: orphan reader and
multi-controller recovery, unresolved placement cancellation and active expiry;
retain the full remaining storage/provider/interactive/client/benchmark scope.
No paid resources or original GC experiment changes. Test jobs terminal and cleaned.

Queued-deletion continuation: deletion now atomically cancels an undispatched
placement operation/ticket and marks the sandbox deleted. Ticket tombstones prevent
late queue admission or create replay from reviving cancelled work. Host reservations
persist whether allocation was dispatched: unused reservations with no demand retire
without provider I/O; dispatched reservations reconcile their original allocation ID
even after cancellation, then retain/retire any resulting idle host without executing
the deleted sandbox. Two tests cover pre-dispatch cancellation and allocation-ACK
loss followed by deletion/controller restart, proving zero workload requests and no
duplicate physical allocation. Twenty-six TypeScript tests, build/typecheck/Biome
pass. The real API fixture now deletes excess queued demand while another assignment
owns the sole host. Await CI. Starting/quarantined placement deletion, orphan reader
and multi-controller recovery, active expiry and the remaining full release gates
remain open. No paid allocations or original GC experiment changes occurred.

Verified queued-deletion source: **2e0131527e60696663519c11c4d857d733a48d33**,
CI **41214822684**, all four jobs successful; watcher 10244 terminal0. Real API
log confirms queuedDeletion=true while the original assignment completes all three
ACK-loss recoveries and retained-history deletion. All 59 unit tests pass. Dispatched
allocation cancellation is fault-tested with a provider double; real Boat allocation
recovery remains unqualified. Next: starting/quarantined deletion, active expiry,
orphan reader and multi-controller recovery, then remaining full adapter/storage/
interactive/client/benchmark gates. No paid host or original GC experiment changes;
all current CI jobs are terminal and cleaned. Full goal remains active.

Expiry-drain continuation: server-owned reconciliation admits one durable stop per
assignment five minutes before allocation expiry. Placement excludes hosts inside
that drain window; released idle hosts in the window retire instead of taking new
work. The stop uses existing output/archive journaling and publication/cleanup gates.
A failed save stays quarantined even past the deadline; expiry is not evidence that
release is safe. A restart test covers boundary timing, repeated source failures,
no premature removal/retirement, successful recovery and exact archived bytes.
All 60 unit tests, build/typecheck/Biome/Ruff pass. The real API fixture now uses its
injected controller clock to trigger active expiry, then reads the workload's file
bytes from the durable archive. Await CI. This is not real Boat forced-expiry or
outage qualification: five minutes cannot guarantee completion for every workload
or provider failure. Starting/quarantined deletion, orphan-reader/multi-controller
recovery and all remaining adapter/storage/interactive/client/benchmark gates remain.
No paid resources or original GC experiment clock/state changed.

S3 core recovery continuation: live-provider credentials are pending; no remote
objects or hosts allocated. Added SDK wire-fixture coverage combining persisted
SQLite reopening with a committed object PUT whose HTTP acknowledgement is lost.
Retry must publish without rereading the absent source or uploading the frame again.
A second root reuses the immutable frame; retirement/collection must preserve it
while retained or read, then allow deletion only after the final retirement grace.
Reconstruction checks exact compressed hash and decompressed binary bytes. Grace
uses an injected clock; this is not the separate real-time qualification. Await
local checks and exact-SHA CI. Full release gates remain open.

Verified S3 core recovery source **4f7d6372ed7095a02f901157c71fe53820acdab7**,
CI **41220147910**, all four jobs successful; watcher 9811 exited 0. All 81 unit
tests (39 TypeScript including subtest, 42 Python), build/typecheck and linters
pass in CI. Disposable SSH/runtime fixtures terminated and cleaned their listeners.
Live R2 still awaits bucket-scoped S3 credentials/configuration; local environment
discovery found management credentials only. User asked for private local credential
file path, never secret text. No provider calls, paid allocations or protected
experiment changes. Continue other remaining gates while access is pending.

GC metadata/journal continuation: collection validates persisted registry/root
shapes, timestamps, owner scope, pins, immutable-frame descriptor consistency and
clock values before storage I/O. Collection IDs now retain a durable candidate plan
and per-object cursor, survive SQLite reopen and return persisted completed results.
A lost delete ACK retries only its immutable object; prior acknowledged deletes are
not repeated. Tests inject malformed metadata and a real deletion followed by lost
ACK, then reopen SQLite and verify exclusion, recovery and replay. All 41 TypeScript
tests pass before the final journal-shape strengthening; final checks/CI pending.
This remains known-frame collection: complete orphan inventory/pagination, full
concurrent-controller qualification and real-grace hosted tests remain open. No
paid-host or remote storage activity and no changes to the protected experiment.

Current published source **ba42eab9774694fb9442624a055b7e32cc3c864b**, CI
**41220566212**. Watcher **39107** is live; unit/build/lint, rootless-runtime and
SSH-control jobs passed, API job124594046402 still running at last bounded poll.
Do not restart this workflow after observation timeouts. Local final41TypeScript
tests pass; Python42tests pass in CI. Next continuation first poll watcher39107
or exact run; investigate any terminal failure and retain evidence. Remaining GC
work includes root payload/manifest consistency, complete inventory/orphan marking,
bounded pagination and concurrent-controller proof. Live R2 credentials still
pending; other provider/interactive/client/benchmark gates unchanged.

Verified prior GC source ba42eab9774694fb9442624a055b7e32cc3c864b: CI41220566212
completed all four jobs successfully; watcher39107 exited0. API qualification took
3m53s and completed cleanup. No workflow restart was needed.

Payload-consistency continuation: recognized filesystem manifests must exactly match
the stored frame descriptors before publication, restore-host contact or GC. Command
output roots require terminal identity/status, complete ordered channel indices and
bounded frame extents. Unknown typed formats fail closed; metadata-free roots retain
only their explicitly listed objects. Publication freezes metadata before asynchronous
verification. Added malformed payload/index tests proving zero storage calls, plus
a restore test proving no host contact on a corrupt map. Two old test fixtures now
use complete valid output metadata instead of partial sentinels. Final checks/CI
pending. Full inventory GC, interactive/provider/client qualification remain open.
