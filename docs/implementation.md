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

CI41227046559 failed installed bootstrap API readiness: correcting XDG runtime
revealed another inherited path, /home/runner/.config/containers/storage.conf.
Private evidence /tmp/jetski-runtime-owner-api.log. Replace incremental environment
exclusions with a dedicated ordinary Python service entry: explicit account paths,
PATH/LANG and only systemd activation fields retained. execve preserves activation
PID. Per-user service drop-in invokes it; bundle verifies installed bytes. Unit test
rejects inherited storage/config/credential variables and root identity. Local
56TypeScript/48Python tests, build/typecheck/lint pass. Hosted CI pending. Previous
failures remain evidence; no real-provider spend or protected experiment changes.


Environment fix22e909d, CI41226947132 exposed bootstrap configuration-directory
ownership: root-created user unit directories prevent systemctl enable writing its
wants symlink. New directories now belong to the dedicated runtime account; the
unit remains scoped to it. Preserve failure; final API/environment proof pending.


CI41226730157 failed SSH/API; dedicated service journal identifies inherited
XDG_RUNTIME_DIR=/run/user/1001 not owned by its current user. Rootless standalone,
unit and Boat bootstrap passed. Private receipt /tmp/jetski-runtime-service-ssh.log.
Candidate fix scopes service environment to the dedicated account with a per-user
unit drop-in and verifies GET /info during bootstrap before declaring readiness.
No host-wide unit or desktop changes. Qualification pending; preserve failed runs.


Current diagnostic source08f1e44d99fb187715d9af0a0077c4ebb7440c8c,
CI41226730157 running. Previous41226543801 finished failure: native/runtime,
unit and Boat bootstrap passed; SSH/API failed. Bounded SSH receipt identifies
exec-create / ConnectionResetError, before workload launch. Private evidence
/tmp/jetski-worker-stage-ssh.log; no raw exception/nonce exposed. Next diagnostic
CI captures only the dedicated disposable account's Podman service journal after
failure; investigate socket activation/service startup before changing execution.
56TypeScript and47Python tests pass locally; cancellation SQLite restart and
lost-ACK test passes. Previous watchers70131/78054 exited1. No paid resources or
protected experiment changes. Installed command execution is currently unqualified.


Candidate dd9ab54697337228085ca21af3bb1fde42163aef, CI41226366001: test,
rootless-runtime and Boat bootstrap fixture passed; installed SSH command failed
with uncertain instead of succeeded (job124611239257, private log
/tmp/jetski-cancel-ssh-ci.log). API job pending at observation. Preserve this failure;
do not claim integrated cancellation qualified. Added bounded stage/type diagnostics
(no raw exception or nonce), and SQLite restart/lost-cancel-ACK test passes. Next
run determines failing worker phase before repair. Watcher70131 observes original
run; do not restart it or count replacement as original success.


Command integration candidate: bootstrap now compiles/installs the supervisor on
owned/disposable hosts and enables the private rootless socket. Command workers
persist exec/start intent, stream bounded output and require authenticated cleanup
before terminal success/cancellation. Queued cancellations prevent start; running
ones target the exec session. Core persists cancellation intent and reconciles it;
API/SDK/CLI expose owner-scoped cancellation. Missing proof remains uncertain and
quarantines the assignment. Added queued replay/fencing checks and a real API fixture
for independent survivor/descendant cleanup and lost cancellation acknowledgement.
Local build/typecheck/lint and47Python tests pass. Full TypeScript and disposable
CI qualification pending; no hosted or API integration success claimed yet. No paid
resources, desktop runtime execution or protected experiment changes.


Integration constraints for the next worker change: nonce material must never enter
public command status/inspect responses, arguments, environment, checkpoints or
logs. Keep it in a separate mode0600 host-control file if restart recovery needs
persistence. Public receipts contain only verified status/exit/cleanup evidence.
Persist the runtime exec ID and start intent before attach; uncertain starts are
not replayable. A queued cancellation can finish without execution, but an admitted
start requires authenticated cleanup or whole-assignment quiescence evidence.
Drain/verify output concurrently with cancellation so the supervisor can emit its
receipt. Stream failure/forced supervisor death stays uncertain and quarantined.
Bootstrap must install the native artifact and private runtime socket on owned
hosts; never compile/run workload helpers on the operator desktop. A native build
in each disposable/owned host is an initial option; pinned release artifacts and
priming cost remain a later packaging/benchmark consideration.

Current candidate **bacf98bf3f05d6e52ff6863dc178fc0ffbd9375e**, CI **41225610972**
passed all five jobs; watcher70912 exited0. Rootless job124609014763 confirms
authenticatedCompletion=true and killedSupervisorRejected=true, plus all prior
ordinary/detached descendant, binary-stream and independent-session checks. No
public command API integration is claimed. Disposable resources cleaned. Continue
with host install/worker/core/API/SDK integration using the constraints above.

Completion-proof continuation: prior supervisor turn was verified progress with
all five CI jobs passing. Added a 256-bit per-command nonce delivered over private
attach stdin only after the supervisor disables dumpability. The child erases its
copy and receives /dev/null stdin; no nonce appears in argv/environment. After
ECHILD, the supervisor writes an authenticated trailing stderr receipt distinguishing
normal exit from cancellation. A bounded decoder removes that control tail from
user output and rejects absent, truncated, altered or trailing-data receipts.
Local46Python tests include all marker split points and wrong-nonce rejection.
The disposable fixture now requires exact receipts for natural and cancelled exits,
checks workload stdin is empty, and kills the supervisor to prove missing completion
cannot be accepted. Public worker/core/API cancellation integration remains pending;
this is a required integrity prerequisite, not a replacement for the full gate.
No paid host, desktop runtime or protected GC experiment changes occurred.

Current candidate **d4de9c120d78260177f530608c785741642e6d88**, CI **41225207351**
passed all five jobs; watcher45820 exited0. Rootless job124607809083 confirms
ordinary and detached descendants fully reaped, exact binary streams, repeated
removal, surviving independent command and running sandbox. Cleanup completed.
Retained failure41224774233 is terminal and must not be restarted. Native C was
compiled/run only in disposable CI; local check was syntax-only.

Next integrate the verified supervisor into host installation and command workers,
with durable session/start/cancel identities and completion proof. Do not infer
successful cancellation solely from an absent exec session: forced supervisor death
or a failed cleanup can remove the session without proving descendants are gone.
Then expose cancel through core/API/SDK/CLI with owner/generation checks and lost-ACK
replay tests. Interactive/PTy/network, hosted replacement/client/benchmark gates remain.

Supervisor continuation: prior failed run41224774233 is terminal failure, with the
new live-descendant assertion as its root cause; this was verified progress, not a
passing cancellation qualification. Implemented a tiny Linux C subreaper prototype.
SIGTERM/SIGINT request cancellation; its single reaping thread kills only unreaped
owned children, adopts orphaned descendants and waits for ECHILD before exit. This
avoids PID-reuse signalling of unrelated processes and handles setsid descendants.
A static binary is built and mounted read-only only on disposable CI. The original
ordinary-child test is stricter (no remaining zombie), and a detached orphan test
was added while retaining independent session and binary-stream checks. No public
command path uses this yet. Forced supervisor SIGKILL/host failure still require
uncertain/quarantine semantics, not successful cancellation. Prototype qualification
is pending; package/bootstrap integration and durable cancellation remain open.

Current source **235a195297b458941c9738e0954ba0170089957a**, CI **41224774233**,
watcher **31798**. Rootless-runtime job124606538529 failed the new exec-session
qualification: forced session removal left a live child process. Actual binary
streams, primary session removal, independent survivor and sandbox liveness ran
before the child assertion. The failure is consequential: API removal is not a
command-tree cancellation primitive. Do not remove/weaken the descendant assertion
or expose per-command cancellation as qualified. Receipt log is privately retained
at /tmp/jetski-exec-ci-failure.log; CI is authoritative for permanent evidence.

Next: implement supervised process-tree cancellation (with PID-reuse safety and
no cross-command effects), or a proven per-command kernel process boundary, then
rerun this exact workload and integrate durable cancel intent into host/core/API/
SDK. A likely approach is a tiny read-only mounted native subreaper supervising
its own descendants; verify daemonized/reparented children as well as ordinary
shell children. This is a design hypothesis, not implemented or proven. Do not
substitute killing a CLI process, process group alone, or the whole assignment for
the required per-command guarantee. Preserve current conservative assignment-wide
behavior until the new path qualifies. No paid resource or desktop runtime change.

Exec-session continuation: prior bootstrap turn was verified progress; CI41224293047
passed. Podman4.9's API supports immutable exec session IDs, multiplexed output and
forced session removal. Added a bounded Unix-socket protocol implementation plus
binary/truncated-header tests. A new disposable rootless CI fixture will verify
binary output, repeated removal, concurrent-session survival, live-descendant cleanup
and continued sandbox use. No desktop runtime or paid host is used. This is the
runtime foundation; public command cancellation is not integrated or advertised yet.
The experiment must pass before replacing assignment-wide cancellation. Local45Python
tests and lint pass; hosted CI pending. Full objective/gates remain unchanged.

Current source **475b4185fdcda3ae32acc51c7572a11b7a4b5110**, CI **41224293047**
passed all five jobs. Watcher39981 exited0. Boat log confirms nonRootProviderCommands,
automaticBootstrap, bootstrapAcknowledgementRecovery, policy-conflict rejection,
large-input integrity and four private-directory cleanups. This is disposable Linux
behind an emulated Boat envelope; no live Boat resource exists. Next: per-command
cancellation and interactive transports, then full remote-store/physical-host/client
qualification and matched benchmarks. Do not mark the full release complete.

Bootstrap continuation: the previous turn made verified progress (live R2 storage
and recovery plus green CI41223577252). Inspection found that earlier Boat CI ran
provider commands as root, masking the documented non-root guest boundary. Fixed
transport to elevate only the installed privileged control program; the revised
fixture runs commands/uploads as the unprivileged CI user.

Automatic owned-host bootstrap and standalone provider selection are implemented.
Code/installer/policy digests are journaled before dispatch; root-owned installation
lock/receipt and full installed-byte checks support lost-ACK replay and reject
conflicting policy/code. Missing runtime prerequisites install only on owned VMs.
The new CI fixture starts without a preinstalled agent, injects a committed bootstrap
ACK loss, then requires recovery, unchanged replay without commands, policy conflict
rejection and all prior large-input/corruption/cleanup checks. Local55TypeScript+
42Python tests, build/typecheck/lints pass. The revised real host-script fixture passed inCI41224293047.
No live Boat call, paid allocation or protected real-grace test changes occurred.

Current published source **890533a2c5aa9e8bb117107134db23e23261928a**, CI
**41223577252** passed all five jobs; watcher **4019** exited0. Local build/typecheck/
lint and53TypeScript tests pass; CI also passes42Python tests. The new checkpoint-
storage harness passes both local and live R2. Disposable CI listeners completed
cleanup. Private live receipts/configuration and seven-day credentials are at
`/home/frtn/.local/state/jetski-qa/20261031/r2/`, outside git; credentials.env must
never be printed or published. Token expires November7. Both live fixture receipts
confirm cleanup; reservation markers intentionally remain. Full acceptance remains
open. Continue Boat bootstrap/configuration and remaining interactive/provider/
client/benchmark gates; no paid host allowance has been added.

Current source before this continuation: **18fe180f1547b476e61bd9a361c7c3740e83e393**,
CI **41222791893**, all five jobs successful. Boat fixture logs confirm actual
host-control execution, large-input verification, corruption rejection and two
private-directory cleanups. This is disposable Linux with an emulated provider
envelope, not live Boat. No need to restart previous watchers.

The isolated private R2 bucket and seven-day bucket-only object read/write token
were explicitly approved and created. Credentials remain outside the repository;
expiry November 7, 2026. Live storage conformance passed all12checks in5361ms,
including one-entry pagination and fresh-client recovery. All6fixture blobs cleaned;
permanent identity markers intentionally remain.

Added a generic checkpoint-storage recovery executable and local CI step. Its11
checks pass on local storage and live R2 (4213ms): committed upload ACK loss,
SQLite/storage-client reopen, source-independent publication, changed-frame-only
upload, replay, exact binary reconstruction, reader/pin/shared-frame protection,
and deletion ACK loss/reopen. Exactly2adapter puts; bothfixture blobs cleaned.
Faults are injected at adapter-return boundaries; GC time is synthetic and scoped
to disposable fixtures. This does not qualify provider outage, real-grace GC,
filesystem extraction or physical-host replacement. No paid host was allocated;
the separate real-grace experiment was untouched. Final checks and all five CI jobs passed.

Next: finish Boat bootstrap/configuration, full interactive transports and live
S3-backed execution/replacement. Keep the remaining client and matched benchmark
gates open. Live R2 access is now available; no new credential permission is needed
within its approved bucket scope and seven-day duration.

Boat allocation/inspection/retirement implementation now exists behind its own
subpath. HTTP fixture tests qualify frozen create replay acrossSQLite reopen,
expired uncertain request refusal, ownership/readiness/deletion fences and bounded
responses. No live Boat calls or paid machines were used. The adapter requires a
separately installed host agent and transport; automatic bootstrap, control-channel
integration and standalone configuration are still unfinished. Next implement that
usable host path, then interactive transports, keeping paid qualification separate.
Official provider contract sources are linked in docs/boat.md; idempotency is24h,
while adapter refuses creation retries beyond its requested<=1hlifetime.

Two SQLite controller connections now qualify superseded inventory fencing,
competing ID and reader/writer exclusion, retained-object preservation, and result
replay. Corrupt observations/cross-owner candidates fail before deletion. Each
physical deletion rechecks generation, collection and cursor before dispatch.
These checks are not broad distributed partition or full lifecycle qualification.

Scoped orphan inventory is implemented with64object persistent pages, complete-pass
receipts, immutable first-seen observations and24hgrace. Restart re-enumerates fully;
partial listings cannot admit deletion. The66object fixture covers grace, retained
publication, partiallisting, deleteACKloss/reopen and replay. Live cloud storage and
real-grace execution remain unqualified. Core holds at most100000inventoryobjects;
local adapter still reads directory names, and metadata compaction is not implemented.
No paid hosts, cloud storage writes or protected experiment changes occurred.

Next: observe CI, then implement the remaining Boat host adapter and interactive
transports (command cancellation, PTY, SSH gateway, previews and TCP). Live R2 functional storage checks now pass; full recovery gates remain. Full provider/parity/fresh-host/client/
benchmark gates remain open. Keep the full acceptance matrix authoritative.

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

Inventory continuation: complete scoped enumeration now precedes deletion planning.
Durable 64-object pages have explicit completion receipts; retries start a fresh
fenced attempt and re-enumerate. First-observation records impose24hgrace on orphans.
Known roots remain authoritative, including an orphan published after discovery.
Duplicate/foreign entries, inconsistent observations and omitted existing known
objects fail closed. A66object test exercises two pages, the grace boundary, retained
publication, interrupted listing with zero deletes, lost delete ACK, SQLite reopen
and stable result replay.45TypeScript tests pass before the final omitted-object
check; finalchecks/CI pending. Core caps inventory at100000objects and retains its
map in memory; metadata compaction and broader concurrency/live-provider tests remain.
PreviousCI41221063301 at5ff2a89 passed all4jobs; watcher11645 exited0. No remote
storage writes, paid hosts, or protected experiment changes.

Collector concurrency continuation: CI41221469787 at2e97b87 passed all four jobs;
watcher93674 exited0, owned disposable listeners/hosts completed cleanup. New test
uses two independent SQLite connections/controllers, stalls one inventory, checks
that competing collection IDs/readers/writers are excluded, resumes the same ID on
the second controller, and verifies the superseded first attempt cannot delete or
complete its stale inventory. Another test injects malformed first-seen records and
cross-owner candidate corruption with zero deletes. Observation records reject
unknown fields, and each deletion now rechecks generation/operation/cursor before
dispatch as well as after acknowledgement. These tests do not prove arbitrary
network partitions or all multi-controller lifecycle paths. Local final checks and
CI pending; provider/interactive/client/benchmark gates remain open.

Boat adapter continuation: priorCI41221713515 at5234d11 passed all four jobs;
watcher84585 exited0. Added explicit Boat API/provider subpath with durable create
request/idempotency identity before dispatch, one-hour lifetime, snapshots/monitoring
off and no inherited environment. Lost-ACK retry retains exact body across SQLite
reopen/config changes; expired unknown creation cannot issue another POST. Provider
readiness requires the separately bootstrapped host-control attestation. Retirement
is ownership/allocation-fenced and observes absence after accepted deletion. HTTP
is HTTPS-only, no redirects/retries, bounded1MiB/30s. Official provider docs reviewed.
Tests use HTTP fixtures, not hosted allocation. Boat bootstrap/transport discovery
and standalone wiring remain required before useful live-host qualification. No
paid host/remote storage/protected experiment changes. Local final suite/CI pending.

Boat control continuation: previousCI41222088859 ate221820 passed all4jobs;
watcher79933 exited0. Added owned-host protocol transport through Boat commands,
strict receipts/bounds/uncertainty semantics and cancellation propagation. Large
requests cannot safely occupy shell argv: above48KiB they use an exclusively
created private directory, provider file upload, full length/SHA verification and
nonrecursive ownership/symlink-checked cleanup. Protocol ceiling1MiB, response2MiB,
provider JSON envelope8MiB.53TypeScript tests/build/typecheck/lint pass. Tests cover
payload metacharacters/Unicode/binary encoding, no unowned/retired dispatch, lost
responses/no retry, cancellation, truncation, mismatch, large inputs and bad upload
receipts. These are wire fixtures; actual script execution and bootstrap/configuration
are still required. No paid VM or remote storage changes. Next qualify on disposable
CI Linux, then wire automatic Boat bootstrap and standalone configuration. Main CI
pending; all remaining interactive/client/provider/benchmark gates stay open.

Boat host-script qualification continuation: added a third disposable CI matrix
variant. It runs BoatTransport's actual shell/Python commands against the installed
host-control agent and rootless runtime, with an emulated provider response envelope.
Small and >argv-limit requests must report real readiness; corrupt uploaded bytes
must fail before control dispatch; private request directories must be absent after
success/failure. This neither calls Boat nor qualifies its network/API service.
Local build/typecheck/lint pass before final fixture-write adjustment. CI execution
is pending; do not run this privileged fixture on the operator desktop. Bootstrap
and standalone Boat configuration still follow, plus full remaining release gates.
