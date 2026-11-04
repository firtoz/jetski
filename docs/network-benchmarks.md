# Public-egress runtime comparison

November 4, 2026: twenty completed cycles across two reversed physical-host pairs,
ten per runtime. Both used the same pinned Node image, one CPU, 512 MiB workload
limit and the new IPv4 `public-egress` policy. These results qualify this fixture;
they do not establish a universal network speed advantage.

## Measured results

Each cycle resolved DNS, made ten sequential HTTPS health requests, downloaded
4 MiB and uploaded 2 MiB to owned R2 fixture objects. Downloads and independently
read-back uploads matched their expected hashes. The exact persistent filesystem
oracle and original command output also matched before each durable save.

| Median                                       |      Podman |      gVisor |
| -------------------------------------------- | ----------: | ----------: |
| Network workload inside guest                |     3.637 s |     2.833 s |
| Warm resume to running                       |     4.708 s |     3.298 s |
| Warm resume to useful response               |     5.712 s |     4.060 s |
| Durable filesystem save and release          |     9.878 s |     8.354 s |
| DNS lookup                                   |     3.66 ms |     7.20 ms |
| First HTTPS health request                   |   177.55 ms |   236.04 ms |
| Later HTTPS health requests                  |   115.34 ms |   121.21 ms |
| Download throughput, complete 4 MiB response | 12.33 MiB/s | 16.59 MiB/s |
| Upload throughput, complete 2 MiB request    |  1.06 MiB/s |  1.83 MiB/s |
| Guest process CPU per network workload       |   151.83 ms |   240.00 ms |
| Post-workload cgroup memory                  |   64.46 MiB |   79.64 MiB |
| Peak cgroup memory                           |  122.41 MiB |  145.39 MiB |

All **80 MiB downloaded and 40 MiB uploaded** matched exactly. Successful save
means durable publication and verification completed, not merely that an upload
started. Warm resumes used verified local cache; cold readiness additionally
included host/bootstrap/image preparation, fixture seeding and the initial useful
response. Its two samples per runtime were **105/122 s for Podman** and
**125/205 s for gVisor**; these are not pure VM boot measurements.

The result is mixed: gVisor completed this network/lifecycle fixture sooner, while
DNS, first-request latency, guest CPU and memory favored Podman. Network location,
provider/R2 variance and the small sample remain important. Guest CPU is not total
host CPU, and workload cgroup memory excludes the separate network helper/NAT.
The workload has a resident 64 MiB application heap. Throughput includes HTTP/body
processing and is not a measurement of raw link capacity.

## Qualification boundaries

Both local engine components also passed Git remote inspection, an integrity-
verified package download and Chromium HTTPS page loading, with owned container
cleanup. The Chromium fixture explicitly disabled its nested browser sandbox;
it used the outer container runtime and never accessed the operator desktop.
These are local component results, not hosted native-browser qualification.

Four setup attempts were rejected before valid timed rows. The fixes covered DNS
read permissions, nft tool/kernel-view compatibility and Podman's nested-user-
namespace sysctl conflict. Failed attempts and cleanup evidence are retained.
The first five native gVisor rows remain valid across the Podman-only fix: its
executed path was unchanged. The artifact boundary is recorded rather than hidden
or replaced with repeated passing trials. All eight hosts used through this
comparison, including failed setup hosts, were positively retired.

The benchmark freezes its workload component. The public example subsequently
uses no-replace file publication so an existing target cannot be overwritten;
that extra filesystem operation was not part of these timing rows.

## Memory and physical replacement

A separate bounded gVisor check passed same-host memory resume and a source-deleted
R2 replacement, with a changing 64 MiB heap, process token/counter, open-file offset,
exact 16-entry / 135,054,203-byte filesystem oracle and original command output.
DNS/HTTPS worked before saving, after warm memory resume and on the replacement.
Native negative-path checks observed six kernel drops for forbidden IPv4 targets;
public IPv6 was refused. Both recovery hosts were positively retired.

The single warm memory resume took **6.67 s**; its subsequent incremental durable
filesystem-plus-memory save took **19.21 s**. Fresh replacement took **296.95 s**,
including a new host/bootstrap and remote verification/restore. Initial source
readiness also took 270.77 s. These are qualification observations, not a repeated
memory-performance comparison, and cold recovery remains expensive.

A scoped deployed embedded-controller trial also passed required gVisor admission,
DNS/HTTPS, Git remote inspection, an integrity-verified package download, exact
10-entry / 1,052,362-byte persistent filesystem comparison, original binary output
and durable stop/same-host resume. This exercised the embedded API, rather than a
full application UI workflow. The real ten-minute idle alarm retired the stopped host automatically;
provider absence and deletion of the temporary control endpoint were verified. The disposable admission scope was removed afterward; its
admitted policy and acknowledged checkpoints remain retained.

External TCP continuity is not promised; applications must reconnect. Existing
runtime/network defaults remain unchanged.
See [network policy and configuration](networking.md) and the
[finite task](goals/gvisor-egress.md).


## Qualification cost

The complete increment used eleven small one-hour-bounded hosts, including four
failed setup attempts, the matched comparison, memory replacement and the scoped
embedded trial. Every owned host is confirmed absent. Provider samples total
2,493 weighted seconds (about 83.8 physical VM-minutes) and **$0.02493 compute
value**; the bounded unsampled retirement tails bring the upper value to less
than $0.0250. Small-host usage seconds have a 0.5 billing multiplier. This value
consumed included compute credits and is distinct from a wallet charge.

All eleven observed start quotes were $0, and the account wallet balance did not
change at the provider's cent precision. These are qualification-period readings,
not a promise of free starts or a retail pricing comparison. The separate $5
allowance was not exceeded. Temporary transfer fixtures are deleted; acknowledged
filesystem and memory checkpoint roots remain retained.
