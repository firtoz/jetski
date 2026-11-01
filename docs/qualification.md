# Qualification evidence

This document records evidence and its limits, not a release certification.
The live acceptance checklist is in [implementation.md](implementation.md).

## Verified baseline

[CI 41254369411](https://github.com/firtoz/jetski/actions/runs/41254369411)
passed all five jobs at `1776ecb`: TypeScript/Python checks, rootless runtime,
SSH control, standalone API and the Boat-adapter fixture. The Boat job emulates
provider APIs on disposable Linux; it is not live Boat qualification.

| Area                   | Evidence                                                                                                                                         | Boundary                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Core and storage       | Tests under test/ and host/; local/S3 fault contracts                                                                                            | Fault fixtures do not establish every remote provider's consistency                                           |
| API lifecycle          | examples/qualify-api.ts: stop, warm reuse, source-deleted restore, held/historical checkpoints, expiry, lost output/import/save acknowledgements | Same-host fixture; live physical replacement is qualified separately below                                    |
| Host execution         | examples/qualify-ssh.ts and host qualification programs: real isolated execution, cancellation, worker loss and filesystem restoration           | Disposable adopted SSH host                                                                                   |
| Interactive transports | PTY/SSH/TCP tests plus examples/qualify-browser-container.ts                                                                                     | Chrome 156, real rootless container and encrypted host control                                                |
| Browser previews       | HTTPS page/assets, exact binary HTTP/WSS, durable closed stream receipts and revoked admission                                                   | Fresh test profile pins a one-day fixture certificate key; not public CA or operator deployment qualification |
| Remote storage         | Isolated R2 functional qualification recorded in prior evidence                                                                                  | Not a complete live-provider/storage/replacement matrix                                                       |

Creation admission commits its operation, sandbox and placement ticket atomically.
`test/creation-admission.test.ts` uses real SQLite rollback/reopen to verify queue-write
failure, lost commit acknowledgements, deletion before allocation and stable replay.
Its provider is a fixture; it does not add live-provider evidence.

Idle-host reuse now checks provider readiness before assignment. Confirmed absence
quarantines the exact idle slot and retires its owned allocation before admitting
replacement capacity. Unknown/starting observations keep capacity reserved and do
not dispatch a workload. SQLite/object-store regressions cover exact-byte restore
after disappearance, lost retirement acknowledgements, controller restart and a
concurrent assignment invalidating the absence observation. This adds a provider
readiness check to warm placement; its hosted latency remains to be measured.
It does not recover unsaved changes from an absent active host.

The live Boat/R2 pilot at `268b7fc` passed confirmed source deletion before idle
expiry, fresh-host restoration and exact byte/mode/link oracle comparison. Warm
resume took 3,436 ms; physical replacement took 69,217 ms. Initial/changed/final
saves took 22,737/17,396/15,697 ms. Two hosts were allocated and retired; a final
provider inventory showed zero active hosts and a scoped storage listing showed
zero checkpoint objects. Immutable identity reservations remain intentionally.
These are single-pilot timings, not a matched comparison or a speedup claim.

`CheckpointCopy` has local SQLite/object-store coverage for same-owner copies,
interrupted streams, lost upload/publication acknowledgements, cancellation races
and independent target bytes after source collection. Copies use separate immutable
object identities and protect source readers and target writers until publication
or cancellation. Sandbox placement and live-provider qualification for this copy
path remain open.

Browser tests also verify bootstrap fragment removal, Secure/HttpOnly/Strict cookie
acceptance, script execution and active revocation. Application cookies, iframe
embedding, service workers and other browsers are not qualified. No universal
speedup, zero-loss guarantee or production-readiness claim follows from these tests.

## Active-stream stop regression

The new API case holds a listener and admitted stream open through stop, then
checks terminal stream evidence, old-listener absence and stale exposure/session
rejection after resume. Existing publication fault injections remain enabled.

| Run / source                                                                        | Result                                                                    | Consequence                                                                                |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [41252756358](https://github.com/firtoz/jetski/actions/runs/41252756358), `72c35ae` | Listener readiness failed; cleanup also reported uncertain host control   | Added IPv4/IPv6 readiness and bounded fixture diagnostics; no stop success claimed         |
| [41253025787](https://github.com/firtoz/jetski/actions/runs/41253025787), `499c7cc` | Readiness passed; stop remained uncertain with unresolved command outcome | Found container stop preceding supervisor completion                                       |
| [41253387238](https://github.com/firtoz/jetski/actions/runs/41253387238), `a09b0e8` | API regression passed; SSH intentional worker-loss cleanup failed         | Keep cancellation drain, but permit physical termination with unchanged uncertain receipts |

The cleanup correction passed all five jobs in CI 41253785969, including the
active API stream stop/resume and intentional SSH worker-loss tests. It does not promote uncertain commands to successful
completion: publication/release still require resolved outcomes. Cancellation drain
releases the fence lock while waiting and has a bounded timeout.

## Boat encrypted stream adapter

The Boat fixture in [CI 41254717679](https://github.com/firtoz/jetski/actions/runs/41254717679)
passed on `72a489a`: actual non-root SSH registration, pinned host key, fixed sudo
control entry point, bounded TCP streams and the shared HTTP/WebSocket/browser
preview suite. Unit tests cover persistent key reuse after lost registration,
changed-key rejection and owner/expiry/retirement denial. This uses an emulated
Boat API around a disposable Linux host, not a live Boat allocation. Other jobs
in that exact run were still pending when this result was recorded.

## Initial live Boat findings

The first live pilot exposed two differences from the emulated API: upload receipts
use paths relative to `/home/user`, and the stock `/opt` directory belongs to the
guest user. The transport now resolves the receipt to the exact requested path
before its existing byte/hash checks; bootstrap secures the parent only before a
first installation on an owned machine. The first fixture then failed because it attempted a hardlink across separate
persistent mounts. Its failed state was durably preserved before retiring the VM;
the corrected fixture keeps that link within one mount.

The corrected live Boat/R2 pilot passed on `b4d9be2`: source execution, durable save,
same-host warm restore, changed save, real ten-minute idle retirement, restoration
on a different physical host, exact filesystem oracle and final retirement/cleanup.
The oracle covers bytes, modes, symlinks and hardlinks. Warm restore took 15,182 ms;
replacement restore took 53,234 ms. Initial/changed saves took 23,842/18,988 ms.
These are one-pilot observations, not a matched comparison. This baseline downloads
remote checkpoint data; live cache and interactive transport remain separate gates.

## Verified cache and embedding qualification

The cache-enabled live Boat/R2 pilot passed exact warm and physical replacement
recovery, terminal input/resizing/signals, 512-byte binary TCP forwarding and
confirmed stream closure. Both VMs were retired after their real idle periods;
scoped test objects were cleaned up. Warm restore returned a verified full-length
cache receipt without import chunks (4,577 ms). Replacement restore transferred
remote chunks and matched the changed filesystem oracle (51,633 ms).

These remain single-pilot observations: changed save took 36,269 ms, compared with
18,988 ms in the baseline. A matched workload comparison is still required.

[CI 41258484368](https://github.com/firtoz/jetski/actions/runs/41258484368) passed all
five jobs on `259402d`; the first API attempt timed out fetching Ubuntu packages,
then passed on an isolated rerun. The built package installs with Bun without
lifecycle scripts. Injected bootstrap assets preserve the exact Node-loader source
identity, and the packed artifact verifies every bundled host-source byte. The
[v0.0.0-qualification.1 artifact](https://github.com/firtoz/jetski/releases/tag/v0.0.0-qualification.1)
is an experimental integration prerelease, not completion of the full goal.

## Real filesystem storage recovery

`examples/qualify-filesystem-storage.ts` and `host/qualify_archive_store.py` capture
real framed archives, delete the source tree and local archives, reopen SQLite and
the storage client, then restore both historical versions. An independent oracle
checks bytes, modes, empty files, Unicode, symlinks, hardlinks, rename/delete and
opaque `.git` files. Local storage and the isolated R2 bucket passed on October 31.
Only owned fixture objects were removed; immutable reservation markers remain.

| R2 fixture save | Archive bytes | Uploaded bytes | Reused bytes | Save time |
| --------------- | ------------: | -------------: | -----------: | --------: |
| Initial         |     5,245,389 |      5,245,389 |            0 |  1,757 ms |
| Changed tree    |     5,245,353 |      1,053,031 |    4,192,322 |    791 ms |

These are one-fixture observations, not matched host benchmarks or universal
speedups. This test allocates no execution host and does not prove physical VM
replacement or real-grace garbage collection. CI runs the local storage path;
private receipts retain the live R2 evidence.

## Real-grace R2 collection

An independent fixture was prepared with real wall-clock retirement and an intact,
pinned second filesystem version. Early collection deleted zero objects; the resume
helper also refused early collection. Eligible after **November 1, 2026, 23:51:52 UTC**.
Deletion, replay and exact retained-root recovery remain pending. The helper is
`examples/qualify-filesystem-gc.ts`; private state identifies the owned objects.
This does not alter the separate protected 12:20 UTC experiment, and no VM is held.

## Other consequential failures retained

- [41252044899](https://github.com/firtoz/jetski/actions/runs/41252044899): combined
  browser/container traffic passed, but a test executable left in `/workspace`
  changed the checkpoint oracle. Moving it to `/tmp` fixed the test isolation;
  the archive assertion stayed unchanged. Run 41252297444 verified the fix.
- [41255375198](https://github.com/firtoz/jetski/actions/runs/41255375198): independent
  pinned-Git consumer installation passed; the isolated Chrome startup later timed
  out at Browser.getVersion. No browser evidence is claimed from that job.
- [41250945239](https://github.com/firtoz/jetski/actions/runs/41250945239): one Boat
  fixture runner reached its 15-minute host-setup bound without diagnostic output.
  Cleanup ran. The precise setup stall remains unknown; subsequent runs passed.

## Historical detail

Earlier per-increment notes remain in
[the previous implementation log](https://github.com/firtoz/jetski/blob/a09b0e832c3bbccd1639210bb14c0c4ec54e878d/docs/implementation.md).
That is historical evidence, not current instructions or acceptance status. A
private local copy preserves the last uncommitted handoff details. Do not append
routine CI polling or temporary process handles to this document; update a result
row only when it changes a qualification conclusion.

## Opt-in outbound networking

Commit `dcb4e64` passed [all five CI jobs](https://github.com/firtoz/jetski/actions/runs/41261217878). The rootless runtime fixture verified public HTTP access, rejected the host-loopback route, and removed its container. Default networking remains disabled. This is disposable CI evidence, not a live provider or general destination-filtering claim.

Checkpoint-backed sandbox admission is covered by SQLite restart, authenticated
HTTP/SDK, owner denial, bounded copy, queued cancellation and source-object-deleted
restore tests. Copying does not allocate a host; explicit resume uses the ordinary
restore path. The disposable API qualification also exercises real container
restoration and complete archive re-publication equality. Its current-commit CI
result is required before counting that added hosted check as passed.

A subsequent [API/CLI run](https://github.com/firtoz/jetski/actions/runs/41265330389)
completed the functional assertions but failed to exit before the job's 15-minute
limit. This is preserved as a failed cleanup qualification, not a successful run.
Cleanup-stage and remaining-resource diagnostics are being added to locate the
hang; the previously qualified artifact is unchanged.

Queued resumes can now stop without compute allocation while retaining their prior
checkpoint. SQLite tests cover lost stop acknowledgements, restart, stale stop/resume
replays, and rejection when pool assignment already won. Pool assignment, operation
claim and sandbox ownership commit atomically; injected rollback and lost-ACK tests
recover the same lease with one workload creation. This is local fault-injection
evidence; disposable-host CI and downstream pinned-artifact adoption remain required.

## Edge fetch portability

The first live embedded edge-controller preparation remained queued before any
physical allocation: native `fetch` rejected the adapter instance as its receiver.
A native Workers-runtime fixture reproduced that failure and also exposed unsupported
`redirect: "error"` handling. The provider API and SDK now invoke fetch without a
class receiver, use manual redirects and reject redirect responses without following
the destination. Rejected response bodies are released. Unit tests cover both
receiver-sensitive implementations and redirect refusal; the native runtime fixture
passes with external networking blocked. A subsequent hosted preparation executed,
published an 897,443,388-byte checkpoint matching an independently hashed source
archive, and released its host. This verifies archive identity and publication;
full filesystem replacement and the downstream workflow remain open.

## Bounded parallel checkpoint reads

Commit `3f9db3f` passed [all five CI jobs](https://github.com/firtoz/jetski/actions/runs/41278043369).
Checkpoint transfer can overlap four immutable 256 KiB reads, retaining ordered
output, a 1 MiB batch bound and failure draining. Custom archive sources stay serial
unless explicitly opted in. Existing integrity and publication checks remain.

A live Boat probe alternated ten serial/four-way pairs over the same 1 MiB archive
range. All twenty reads had identical hashes. Median read time was 1,012 ms serial
and 407 ms parallel; the median paired time ratio was 0.400. Each arm made forty
provider requests, with no new host starts. A background checkpoint save was active.
This is a transport latency result, not a complete save, restore or session benchmark.
Private receipts preserve failed probe setup attempts separately from the completed
matrix. Full matched end-to-end qualification is still required.

## Host loss after publication

Local SQLite restart tests cover host disappearance during removal, release and
source cleanup. A fully verified publication can finish release after positive
provider absence, without further workload commands. Unknown provider state,
interrupted upload and corrupt or missing retained objects remain quarantined.
These fault-injection checks do not qualify live expiration recovery; that gate
remains open.

Explicit missing-source recovery has local SQLite and HTTP/SDK coverage: a caller
selects a retained checkpoint and acknowledges unavailable unpublished changes.
The transaction fences the lost assignment, preserves the failed save, and leaves
the sandbox stopped. Restart and lost-response replay preserve the same outcome;
subsequent resume restores the selected archive on one replacement host. Unknown
or still-ready provider state, corrupt storage, stale lease/generation, concurrent
readers and cross-owner requests are rejected. Registry tests also cover unrelated
writers, unidentified writers, retired roots and transaction rollback. This does
not establish that unpublished source bytes survived a real provider expiry.
