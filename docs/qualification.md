# Qualification evidence

This document records evidence and its limits, not a release certification.
The live acceptance checklist is in [implementation.md](implementation.md).

## Verified baseline

[CI 41252297444](https://github.com/firtoz/jetski/actions/runs/41252297444)
passed all five jobs at `fc3298b`: TypeScript/Python checks, rootless runtime,
SSH control, standalone API and the Boat-adapter fixture. The Boat job emulates
provider APIs on disposable Linux; it is not live Boat qualification.

| Area                   | Evidence                                                                                                                                         | Boundary                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Core and storage       | Tests under test/ and host/; local/S3 fault contracts                                                                                            | Fault fixtures do not establish every remote provider's consistency                                           |
| API lifecycle          | examples/qualify-api.ts: stop, warm reuse, source-deleted restore, held/historical checkpoints, expiry, lost output/import/save acknowledgements | Same-host fresh-container recovery; physical provider replacement remains open                                |
| Host execution         | examples/qualify-ssh.ts and host qualification programs: real isolated execution, cancellation, worker loss and filesystem restoration           | Disposable adopted SSH host                                                                                   |
| Interactive transports | PTY/SSH/TCP tests plus examples/qualify-browser-container.ts                                                                                     | Chrome 156, real rootless container and encrypted host control                                                |
| Browser previews       | HTTPS page/assets, exact binary HTTP/WSS, durable closed stream receipts and revoked admission                                                   | Fresh test profile pins a one-day fixture certificate key; not public CA or operator deployment qualification |
| Remote storage         | Isolated R2 functional qualification recorded in prior evidence                                                                                  | Not a complete live-provider/storage/replacement matrix                                                       |

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

The latest correction has 74 Python tests plus build/typecheck/lint passing locally;
its hosted proof is pending. It does not promote uncertain commands to successful
completion: publication/release still require resolved outcomes. Cancellation drain
releases the fence lock while waiting and has a bounded timeout.

## Other consequential failures retained

- [41252044899](https://github.com/firtoz/jetski/actions/runs/41252044899): combined
  browser/container traffic passed, but a test executable left in `/workspace`
  changed the checkpoint oracle. Moving it to `/tmp` fixed the test isolation;
  the archive assertion stayed unchanged. Run 41252297444 verified the fix.
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
