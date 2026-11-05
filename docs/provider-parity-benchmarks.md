# Boat / boxd feature parity

November 5, 2026. Both machine providers now pass the same changed-path Jetski
qualification: Podman and gVisor, public egress, interactive transports and R2
recovery. These APIs are source previews, not in npm 0.1.1.
[Machine-readable results](benchmarks/provider-parity-2026-11-05.json).
The [earlier baseline](boxd-boat-benchmarks.md) remains separate evidence with a
lighter workload; do not combine its rows with these.

## End-to-end measurements

Seconds. Five warm cycles per arm, including independent filesystem verification
and durable R2 publication before release. Same pinned Alpine image, one CPU /
512 MiB workload limits, static application, 4 MiB binary, session markers, Unicode,
empty paths, modes, symlinks and hardlinks. Podman uses FUSE-overlay storage;
gVisor uses its default storage. Boat uses `small`; boxd uses two vCPUs / 8 GiB.
Physical capacity, kernel and provider contention differ. Fresh readiness includes
bootstrap and safe same-machine reconciliation, rather than VM boot alone.

| Measurement           | boxd Podman | Boat Podman | boxd gVisor | Boat gVisor |
| --------------------- | ----------: | ----------: | ----------: | ----------: |
| Fresh sandbox ready   |       37.10 |       54.64 |       38.64 |       68.20 |
| Median warm resume    |        2.51 |        3.52 |        2.26 |        3.26 |
| Median durable save   |        4.53 |        5.53 |        4.76 |        4.77 |
| Median complete cycle |        8.34 |       11.86 |        8.47 |       10.80 |

Each timed cycle makes 28 S3 requests and transfers about 966 kB in each direction.
Medians of component stages need not sum to the median cycle. This small sample
favored boxd warm latency; gVisor saves were effectively tied. It does not establish
universal provider rankings, equal physical CPU performance or failure rates.
Podman observations precede the gVisor supervisor repairs described below; their
successful workload paths are unchanged, and were not repeated.

## Qualified behavior

- Both runtimes/providers pass actual PTY input, resizing and signals, SSH
  detach/reconnect, binary TCP, HTTPS/WebSocket previews, anonymous rejection,
  public internet access and metadata denial. Preview credentials are stripped
  before reaching the workload.
- boxd idle RAM and disk sleep/wake both pass on the same physical machine:
  **3.26 s** each including sandbox readiness. This freezes an already released
  idle host/cache, not active workload processes. Boat explicitly rejects this
  optional provider capability.
- Both gVisor arms restore process memory locally and from R2 on a **different
  machine after source deletion**. Exact filesystem content/modes/links, process
  token, counter, heap checksum, open-file offset, session marker and retained
  original command output match. These observations are not a zero-loss guarantee.
- Boat replacement took **95.03 s**. boxd's **109.81 s** includes a preserved
  harness interruption and recovery on the same pending operation/machine; it is
  not a clean head-to-head replacement-latency result. No command was blindly
  replayed and no extra replacement was allocated for that interruption.

Typed Node and standalone configuration now share runtime/network/storage/init
policy, provider-neutral bootstrap, optional SDK loading and capability discovery.
Adaptive pricing keeps EUR/USD explicit and never silently converts currencies.
Native sleep/wake uses persisted intentions and fences placement until observed.
See [configuration and safety](boxd.md), including uncertain native transitions.

## Failures that changed the implementation

The first boxd public-egress pilot lacked the nftables netdev egress hook. No
workload was admitted. A shared tc/classic-BPF backend now enforces the same policy,
checks packet bounds and reads back exact installed bytecode. Its empty failed
source was independently inspected before retirement. There is no unfiltered
network fallback.

One Boat gVisor upload had an unclassified uncertain control response. Its retained
R2 checkpoint independently reproduced the acknowledged application bytes/mode;
the uncommitted file was absent. A later Boat gVisor case exposed unsupported
`TIOCSIG`. The command supervisor now retains the normal ioctl and uses configured
terminal signal characters only on unsupported kernels with `ISIG` enabled. Raw
or disabled-character signalling remains unsupported on that compatibility path.

A boxd gVisor case then exposed non-terminal cancellation ignoring private-input
EOF. The supervisor now treats EOF as a cancellation request and authenticates
completion only after descendant cleanup. Both repairs have real local process/
PTY tests and pass the revised hosted cases. No numeric PID/group lookup fallback
was added. These fixes are shared across providers.

The two uncertain-command sources stayed quarantined. Independently verified
emergency filesystem archives were read back from R2 before owned retirement;
these were not successful managed releases. Their uncertain outcomes remain
uncertain. Original failures and the interrupted replacement are preserved in
private receipts; successful rows were not substituted for them.

## Cost and cleanup

This goal used **five physical starts per provider**, including failed attempts and
replacement machines. All ten owned machines are confirmed absent. No snapshots,
top-ups or prior experiment funds were used. The temporary organization key was
revoked, a fresh client confirmed authentication rejection, and private credential
copies were removed.

From allocation intention through confirmed absence, total physical lifetime was
**0.314 host-hours on Boat** and **0.473 on boxd**. At the observed Boat small rate
of $0.018/hour, that is **$0.00565 compute value**, not an attributable wallet debit.
Account-level credits and other activity prevent inferring this goal's bill from
whole-account deltas; start charges are not invented.

boxd's owned-machine meter reported **€0.01282** at closure, but was **not fully
settled**. A deliberately conservative full CPU/RAM capacity estimate for those
same intervals is **€0.08229 before disk**, whereas billing meters actual CPU,
resident RAM and written disk. Observed rates were €0.039/vCPU-hour,
€0.012/GiB-RAM-hour and €0.00008/GiB-disk-hour. These are different billing models;
the partial meter is not a final invoice or evidence of a cost winner. Both are
well inside the separately approved $10-per-provider allowances. No FX conversion
was used by the idle policy.

Local closure: **378 TypeScript tests, 238 Python tests**, build, typecheck, lint,
Python checks, strict boxd example and packed-consumer checks pass. The artifact
loads every subpath without the optional boxd SDK installed. No new package
publication or production cutover is included. The user subsequently authorized
publishing the source to main, with exact-commit CI as the final publication gate.

## API follow-up

The [failure recovery API](failure-recovery.md) subsequently moved bootstrap
uncertainty handling into the adapter, preserved structured safe transport details,
and added GET-only `waitForOperation()` helpers for SDK and embedded sessions.
Local regression coverage now totals 385 TypeScript tests, with build, typecheck,
lint and packed consumer passing. Host sources and the measurements above are
unchanged; this follow-up did not allocate machines or repeat hosted qualification.
