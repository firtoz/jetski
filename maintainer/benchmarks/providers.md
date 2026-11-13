# Boat and boxd profiles

Measured November 5, 2026. Both providers passed the matched changed-path matrix:
Podman/gVisor, public egress, interactive access and R2 recovery.
[Sanitized aggregates](data/provider-parity-2026-11-05.json). The
[earlier lighter baseline](data/boxd-boat-2026-11-05.json) is a separate fixture,
not another set of observations to pool with these rows.

Five warm cycles per arm used the same pinned Alpine image, one CPU/512 MiB
workload limit, a static application, 4 MiB binary, markers, Unicode, empty paths,
modes and links. Podman used FUSE-overlay; gVisor used default storage. Boat
`small` and boxd 2-vCPU/8-GiB physical capacity differ. Readiness includes bootstrap
and safe same-machine reconciliation, not VM boot alone.

| Seconds               | boxd Podman | Boat Podman | boxd gVisor | Boat gVisor |
| --------------------- | ----------: | ----------: | ----------: | ----------: |
| Fresh sandbox ready   |       37.10 |       54.64 |       38.64 |       68.20 |
| Median warm resume    |        2.51 |        3.52 |        2.26 |        3.26 |
| Median durable save   |        4.53 |        5.53 |        4.76 |        4.77 |
| Median complete cycle |        8.34 |       11.86 |        8.47 |       10.80 |

Each cycle made 28 S3 requests and transferred about 966 kB per direction.
Component medians do not sum. Different kernels/capacity/contention and small
samples prevent universal provider or cost rankings. Podman rows precede shared
gVisor supervisor fixes; unchanged successful paths were not repeated.

## Qualified behavior and failures

Both provider/runtime profiles passed PTY input/resize/signals, SSH reconnect,
binary TCP, HTTPS/WebSocket preview, anonymous rejection, public internet access
and private/metadata denial. Preview credentials were stripped before workload
delivery. boxd idle RAM/disk wake each took 3.26 s on the same physical machine;
this freezes a released host/cache, not an active workload. Boat rejects that
optional capability.

Both gVisor arms recovered RAM on different machines after source deletion:
filesystem bytes/modes/links, process token/counter/heap, open-file offset, markers
and original command output matched. Boat replacement took 95.03 s. boxd's
109.81 s includes a harness interruption resumed with the same pending operation/
machine, so it is not a clean head-to-head replacement-latency comparison.

Material failures constrain these claims:

- boxd's missing nft netdev egress hook blocked workload admission. The equivalent
  verified tc/classic-BPF policy passed; no unfiltered fallback was used.
- A Boat gVisor control response left a command outcome uncertain. Retained R2
  objects reproduced acknowledged bytes, excluding an uncommitted file.
- Unsupported `TIOCSIG` required the configured terminal-character path only when
  `ISIG`/signal characters permit it; raw-mode signalling remains unsupported there.
- Nonterminal private-input EOF required authenticated descendant cleanup before
  cancellation could settle. Numeric PID/group lookup was not substituted.

The two uncertain-command sources stayed quarantined. Independently read-back
emergency archives supported deliberate forensic retirement; they were **not**
successful managed releases. Unknown outcomes remain unknown.

## Cost boundary

Ten starts, five/provider including failures/replacements, were confirmed absent.
Boat physical lifetime was 0.314 host-hours, $0.00565 historical compute value.
boxd's €0.01282 meter was not fully settled; a conservative full CPU/RAM estimate
was €0.08229 before disk. Fixed compute/start accounting and actual usage metering
are different models; these values are not a final invoice or cost winner.
No implicit currency conversion is valid. [Current capability contracts](../../docs/embedded-platforms.md#capabilities).
