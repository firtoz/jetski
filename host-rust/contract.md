# Native host contract audit

Reference: Python host assets at `8bb303f`. Rust is experimental and selected only by explicit native transport/bootstrap
configuration; Python remains the default. This is the implementation map; see the [hosted report](../maintainer/benchmarks/native-host.md)
for the qualified paths and limits. Ordinary JSON control and binary interactive framing share the
same authenticated host entrypoint; their timeouts must not be conflated.

| Contract group         | Python source / actions                                                                                                                       | Native status                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Control envelope       | `control.py`: protocol1, request ID, strict action payloads, 1 MiB ordinary / 6 MiB import request and 2 MiB response bounds; header deadline | Native bounded JSON/binary header dispatch, 10s header and 120s JSON-body deadlines implemented                                               |
| Identity and fences    | `fence.py`: claim, close-before-claim, generation succession, permanent slot/owner binding, locked journal and verified release receipt       | Native primitives and release verifier wired to matching checkpoint/removed runtime plus observed container absence                           |
| Status/inspection      | `status`, `inspect`; `supervisor.py` configuration/account/root ownership and runtime preflight                                               | Native config/account/probe and entrypoint status wiring implemented; observed maps must match installed identity                             |
| Runtime lifecycle      | `runtime.py`, `runtime_backend.py`, `runtime_service.py`: claim/create/quiesce/finalize/remove/release/purge-source                           | Native lifecycle, cached-resume/finalize, safe source purge and unknown-outcome journals implemented                                          |
| Command supervision    | `commands.py`, `podman_exec.py`, native supervisor: command-start/status/output/cancel; process death and watchdog                            | Native Unix HTTP exec adapter, worker, durable output/cancel and nonce completion proof implemented; live Boat execution/output/cancel passed |
| Files and upload       | `files.py`, `file_upload.py`: file-read/list; file-write-begin/chunk/finish/status                                                            | Native bounded file/list and durable upload primitives implemented; Python chunks/version tokens/upload journals interoperate                 |
| Capture and restore    | `archive.py`, `frames.py`: deterministic traversal/links, bounded tar/gzip proof, fsync, ownership and atomic staging publication             | Native capture/private-staged restore implemented; bidirectional Python tree oracle and corruption rejection pass                             |
| Import/cache           | `import_checkpoint.py`, `local_checkpoint.py`: import-begin/chunk/finish, raw import-file-begin/chunk/close, resume-cached                    | Native resumable imports and release-gated verified cache implemented; combined cached resume wired                                           |
| Source export          | `checkpoint_export.py`: checkpoint-source/close and read-checkpoint                                                                           | Native read-only scoped export links, close and bounded archive reads implemented                                                             |
| Interactive            | stream-reserve/status/cancel; terminal-start/input/input-status; `stream_protocol.py` and broker, binary framing, SSH/PTY/TCP                 | Native terminal-input journal, stream admission/framing and bidirectional broker implemented; live PTY/SSH/binary TCP qualification passed    |
| Installation/selection | `install_bundle.py`, `bootstrap.py`; TS bootstrap assets/hash receipts, host control argv, existing host immutability                         | Opt-in Boat/SSH selection, pinned installer/identity and optional assets loader implemented; installed Boat identity/readiness passed         |

The native journal primitive preserves arbitrary subsystem sections, refuses
symlink/nonregular or nonprivate state/lock files, uses a pinned directory FD,
flock, file fsync, atomic rename and directory fsync. Its caller must validate
trusted supervisor ancestors before opening the root. The native state read is
bounded to16 MiB and fails closed above that bound; final admission limits must
make this compatible with the complete workload journals. It must not silently
truncate, discard or report release for an oversized journal.

Typed JSON rejects unknown/duplicate envelope and lease fields. This is stricter
than Python's generic JSON decoder; final wire parity covers the actual versioned
client contract, while malformed requests fail closed. Safe-Rust application code
uses the `rustix` syscall abstraction; dependency internals remain part of the
trusted computing base. Rust memory safety does not prove filesystem durability.

Compressed bitstreams need not match Python byte-for-byte. Both must validate
existing gzip/tar archives and expanded member hashes. The encoding identity must
be persisted so restarting an interrupted save cannot change its byte geometry.
Cross-language tests exercise gzip frames, lease journals, archive trees and
file/upload receipts, including local source-deleted restoration. The independent
Python oracle checks bytes, modes, Unicode/long paths, symlinks and hardlink groups.
The subsequent hosted matrix establishes the reported container, source-deleted
replacement and interactive paths within its stated scope. Keep failures and targeted tests; do not expand the hosted matrix to
compensate for implementation gaps.

Native restore reads bounded tar headers/PAX/GNU extensions explicitly, rather than
allowing a tar reader to allocate an arbitrary extension body before validation.
Every accepted parent must already be a directory; hardlinks target an earlier
primary file with identical mode. The complete gzip stream is drained through
CRC/expanded bounds and exact compressed hash before inode metadata is fsynced and
private staging is published with a no-replace rename. A post-rename fsync failure
must remain uncertain; published roots are not deleted by the staging guard.

File reads/listings use no-follow pinned descriptors and match Python's metadata
version tokens. Upload journals persist identity before staging and publishing
inode/parent identity before rename. Consumed staging cannot overwrite newer data
on receipt replay. Tests construct reachable lost-progress/lost-publication journal
states and reopen them; full process-death/runtime qualification remains open.

Encoding is valid deterministic gzip/tar, not promised byte-identical to Python:
the native compressor backend and tar encoding/padding may differ. Benchmark
reports must preserve bytes/request counts and disclose those differences rather
than attributing every result to language overhead alone.

The native supervisor command runner clears inherited environment, redirects bounded
output to private temporary files, and launches its own small setsid/exec child
mode followed by GNU timeout. The watchdog runs independently of the control session; local tests check the real native helper's exit/output limits and timeout path, while
control-death uncertainty is covered by targeted local checks rather than a new hosted fault matrix. No daemon or
Python trampoline is introduced. Private `__control` dispatch is selected explicitly
by Boat/SSH transport configuration; default invocation refuses operation.

Native Podman lifecycle arguments and running/stopped/removed receipts match the
recording Python reference. Create intent precedes dispatch and failed/unknown
creation quarantines the lease without another run. Removal retries observe
absence; unknown inspection cannot authorize removal/release. Rootless probe and
workload identity digests/maps also interoperate with the Python reference.
Root-owned installed-file/socket checks are implemented; these pure/local tests
are not qualification of an installed host or its real Podman engine.

Native exec uses a bounded Unix HTTP client and incremental multiplex decoding;
partial frames retain their cursor without blocking cancellation indefinitely.
Queued command IDs/specs persist before launch and are never relaunched after a
lost launcher ACK. A private worker lock distinguishes live supervision from lost
workers. Only an authenticated per-command completion nonce can settle workload
exit/output; missing proof quarantines instead of inventing success. Terminal input
records dispatch before send, so uncertain delivery is observed rather than resent.
These recording-socket tests do not prove an installed engine or live terminal.

Native import checks every resumed prefix, syncs archive bytes before advancing its
journal, and restores into private staging before publishing ready. Extracting replay
can rebuild only an unpublished root. Cache candidates remain owner/sandbox scoped;
corrupt unpublished candidates fall back to transfer, while source I/O uncertainty
and already-published roots remain failures. Binary staging is closed before ready.
Cache publication requires the released generation's exact publication and removed
runtime; lost rename/metadata ACKs recover using verified immutable bytes. Capture
persists encoder/frame geometry before work and refuses conflicting replay. Relay
admission persists intent before exec creation and never reopens an uncertain stream.

The native control connection reads exact binary-header extents, leaving subsequent
relay bytes untouched. It bounds header arrival to ten seconds, ordinary JSON body
to 120 seconds and output backpressure to five seconds. Composite lifecycle tests
exercise a recording runtime: uncertain existence never authorizes release, replay
retains publication/cache receipts, and purge follows released state. The native
TCP broker joins bounded input/output loops and exact exec observations; binary
FIN/ready framing plus stopped/zero-exit inspection are required for complete
receipts. Its socket fixture is not live Podman or an installed SSH gateway proof.

Native installation intent is persisted before the unchanged base bundle. Both
controller state and host records bind the backend/hash; existing base installs
without earlier native intent require replacement. Python dispatch checks for
native intent. Native control/worker entrypoints check a protected marker, scope,
root-owned executable inode/size/mode and selected hash; bootstrap hashes the
artifact before installation and on replay. Readiness attests native identity.
Node asset loading is optional and bounded; ordinary SDK/core imports and npm
installation neither require a compiler nor download native code. CI builds a
separate static musl artifact with source/hash and compiler/dependency notices.

Boat large requests use native directory/file helpers when Rust is selected.
An exclusive transfer directory belongs to the explicitly configured provider
account. JSON files are opened through pinned no-follow descriptors, bounded,
hashed and decoded from immutable memory before dispatch. Cleanup removes only
the expected file and refuses unknown entries or replaced directory identities.
Default Python/bootstrap file transport remains unchanged. Local helper and
provider-recording tests cover corruption, aliases and lost-response cleanup;
installed large-file upload/read passed in the hosted qualification.
