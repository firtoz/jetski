# Jetski

**Portable, durable sandboxes on reusable compute.** MIT licensed.

Run isolated Linux workloads, save their files durably, and resume them on a warm
host or a replacement machine. Jetski separates a **logical workspace** from the
**physical machine** underneath it: many sequential sessions can reuse one host
without requiring a new VM or provider snapshot for every session.

First cloud-qualified with **Boat**. Also supports explicitly adopted Linux hosts
through SSH. Available as a portable TypeScript core/SDK, an optional Node.js HTTP
service and a thin CLI. This is a pre-release with completed hosted qualification;
there is no npm release or managed Jetski hosting service.

## Why use it?

- **Reuse compute:** owner-exclusive pools, demand-created hosts, bounded leases and
  optional adaptive idle retention reduce unnecessary starts and idle time.
- **Keep work beyond a VM:** verified incremental filesystem checkpoints in local
  control-plane storage or S3-compatible object storage, qualified against R2.
  Verified local archive reuse accelerates warm returns; remote storage remains
  the recovery authority.
- **Transfer less data:** independently compressed frames and optional packing
  reuse unchanged content. Hashes, publication verification and generation fencing
  remain mandatory.
- **Reconnect safely:** persisted operation identities and resumable output let a
  client observe existing work after interruption without blindly rerunning it.
- **Bring your infrastructure:** replace host, storage, transactional state,
  scheduling, identity, transport and observability adapters. Importing `@firtoz/jetski/core`
  or `@firtoz/jetski/sdk` does not load SSH servers, SQLite or provider SDKs.
- **Use familiar interfaces:** command execution, files, PTYs, SSH access,
  authenticated HTTP/WebSocket previews and TCP forwarding.

Workloads default to rootless Podman, with an optional gVisor runtime,
**one active assignment per host**, and no
cross-owner host reuse. Filesystem checkpoints preserve declared persistent paths
(`/workspace` and `/home/sandbox`), including bytes, modes, symlinks and hardlinks.
They do not preserve RAM, running processes, kernels or arbitrary host files.

## What we measured

Refreshed November 4, 2026 from the completed hosted runs. The comparisons below
use different workloads and durability boundaries; **do not combine their
percentages into one speedup**. Dates identify measurements, not new reruns.

| Filesystem checkpoint comparison, ten trials per arm | Reference median | Optimized Jetski median |
| ---------------------------------------------------- | ---------------: | ----------------------: |
| Durable save and release                             |          4.923 s |             **2.499 s** |
| Resume readiness                                     |          2.018 s |             **1.104 s** |
| Work/save/resume/independent verification            |          8.034 s |             **4.933 s** |
| Changed payload uploaded                             |         1.042 MB |            **0.263 MB** |

The 64 MiB fixture used equal workload limits, two host pairs and reversed order.
All twenty filesystem comparisons matched. Coordination/storage compositions
differed, storage requests increased, and setup/priming were outside timed rows.
A separate single replacement pair restored 436 MB of logical files in 36.774 s
versus 51.309 s; this is one observation, not a population median.
[Method, failures and limits](docs/benchmarks.md).

| Longer-lifetime comparison, 104 sessions per policy | One hour / fixed idle | Eight hours / adaptive idle |
| --------------------------------------------------- | --------------------: | --------------------------: |
| Physical host starts                                |                     6 |           **4 (33% fewer)** |
| Allocated host time                                 |            194.23 min |  **179.21 min (7.7% less)** |
| Final unused-gap idle retention                     |              600.70 s |     **120.24 s (80% less)** |
| Remote payload downloaded                           |             268.50 MB |    **134.25 MB (50% less)** |
| Median warm resume / durable save                   |         4.13 / 5.58 s |               5.65 / 6.51 s |

All **208** restore/verify/save cycles matched exactly. The adaptive arms avoided
70–92-second busy cold rollovers, but ordinary warm operations regressed. This
trace saved unchanged data and does not establish a universal latency win.
The complete experiment, including separate staging recovery, used twelve hosts
and $0.13511 of included compute credits, with **$0 wallet debit**; all hosts were
retired. A separate staging replacement matched 158 entries / 322,845,310 logical
bytes plus retained session files and acknowledged output.
[Full lifecycle measurements](docs/host-lifecycle-benchmarks.md).

## Get started

Use Node from [`.nvmrc`](.nvmrc). Install the prebuilt package (the CLI is `jetski`):

```sh
npm install --global @firtoz/jetski@0.1.0
jetski --version
jetski --help
```

For an SDK application: `npm install --save-exact @firtoz/jetski@0.1.0`, then import
`JetskiClient` from `@firtoz/jetski/sdk` or compose `SandboxManager` from `@firtoz/jetski/core`.
Registry users do not need TypeScript or a source build. See [contributing](CONTRIBUTING.md)
for checkout instructions, [operations](docs/operations.md) for deployment/backup,
and [releases](docs/releases.md) for versions, containers and upgrades.

A versioned Linux amd64 controller image is built as `ghcr.io/firtoz/jetski:v0.1.0`.
Use its verified digest from the GitHub release once published; keep configuration
read-only and `/data` on a persistent volume owned by UID1000. Example:

```sh
docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  -p 127.0.0.1:8788:8788 --env-file /private/jetski.env \
  -v /private/server.json:/etc/jetski/server.json:ro \
  -v /private/jetski-data:/data ghcr.io/firtoz/jetski:v0.1.0
```

Set `dataDirectory: "/data"` and `host: "0.0.0.0"` in that container's configuration.
Use a dedicated controller volume and TLS reverse proxy for remote access; never
mount a local runtime socket. Workloads execute on the configured remote hosts.

### 1. Configure a host and storage

Copy [the Boat example](examples/server-boat.json) to a private configuration file.
Choose a writable control-plane data directory and review its digest-pinned image
allowlist. Supply `JETSKI_API_TOKEN` (a random secret of at least 32 characters)
and `BOAT_API_TOKEN` through your controller environment or secret manager.
Secrets never belong in the JSON file. Host allocation is billable when demand
arrives; starting the API alone does not prewarm machines.

The example uses local checkpoint storage, one host per owner and opt-in eight-hour
leases with adaptive idle retention. Defaults without that policy remain one hour,
ten-minute idle and zero minimum warm hosts. To use remote storage, replace
`storage` with [the R2 example](examples/storage-r2.json) and supply its named
bucket-scoped credential variables. Back up SQLite metadata as well as objects.
Local storage survives execution-host loss, but not control-plane disk loss.

Alternatively use [the SSH example](examples/server.json) with a dedicated,
operator-prepared Linux x86-64 host; follow the exact bootstrap, forced-command key
and host-key-pinning instructions in the [standalone guide](docs/standalone.md).
SSH retirement releases Jetski's allocation; it never powers off or deletes the host.

### 2. Start the service

```sh
jetski serve --config /absolute/path/server.json
```

The API binds loopback on port 8788. Remote clients need an operator-managed HTTPS
endpoint or authenticated encrypted tunnel. The server worker progresses lifecycle
operations independently of browser connections.

### 3. Run, save and restore a workspace

In another shell, supply `JETSKI_TOKEN` matching the service's API token and
`JETSKI_URL=http://127.0.0.1:8788`. Use the reviewed image digest from your config:

```sh
# Set IMAGE to an allowlisted OCI image@sha256:... value first.
npx tsx examples/durable-workspace.ts init /private/path/demo.json "$IMAGE"
npx tsx examples/durable-workspace.ts create /private/path/demo.json
npx tsx examples/durable-workspace.ts write /private/path/demo.json
npx tsx examples/durable-workspace.ts stop /private/path/demo.json
npx tsx examples/durable-workspace.ts resume /private/path/demo.json
npx tsx examples/durable-workspace.ts read /private/path/demo.json
npx tsx examples/durable-workspace.ts finish /private/path/demo.json
```

The [executable SDK example](examples/durable-workspace.ts) persists IDs before
network effects, writes a text file, publishes a checkpoint, resumes and verifies
its bytes, then durably stops again. Each step is explicit. Keep its plan after
errors: reissue the same step/identity to observe its receipt; an uncertain outcome
requires observation, not a fresh command ID. `finish` releases the assignment;
normal idle/lifetime maintenance retires owned hosts. It retains checkpoint history.

For direct CLI use, create with `create --id UUID --operation UUID --image DIGEST`,
execute with `exec SANDBOX --id COMMAND_UUID -- /bin/sh -c 'printf hello'`, and use
`get`, `operation`, `stop` and `resume` to observe lifecycle work. Admission is
asynchronous: inspect the operation before assuming save or readiness completed.
See [use-case recipes](examples/README.md), [CLI/API details](docs/standalone.md)
and [OpenAPI](docs/openapi.json).

## Embed it or pick adapters

| Boundary                 | Included implementations                                             |
| ------------------------ | -------------------------------------------------------------------- |
| Machine host             | Boat allocation; explicitly adopted Linux over SSH                   |
| Workload runtime         | Rootless Podman default; opt-in gVisor (`runsc`, Python host path)   |
| Checkpoint store         | Local filesystem; S3-compatible; native R2 binding for embeddings    |
| Transactional state      | SQLite for Node; injectable `StateStore`                             |
| Scheduling               | Standalone worker; injectable platform scheduling                    |
| Identity / observability | Owner-scoped bearer auth, gateway keys; injectable policy/event sink |

Pin the registry version in your lockfile, or install the GitHub release `.tgz`
after verifying SHA256SUMS. Both contain built JavaScript, declarations and host
assets. Lifecycle scripts can be disabled. Git-source installs are contributor
workflows; the prepare hook needs build dependencies and is not qualified for Bun.

Embedded clients compose `SandboxManager` from `@firtoz/jetski/core` and supply state,
provider, host transport, storage and scheduling. No standalone service is required.
`@firtoz/jetski/host-assets` supplies bundled bootstrap source without filesystem reads;
see [embedded bootstrap](docs/boat.md) and [native R2 storage](docs/storage-r2.md).

## Does it replace Boat?

**Jetski complements Boat:** Boat supplies machines; Jetski supplies reusable
workspaces, portable checkpoint storage and lifecycle policy on top. It can replace
application-specific pooling/checkpoint orchestration. With adopted Linux hosts it
can also provide a sandbox API without Boat, while you operate the infrastructure.

Jetski is not a microVM hypervisor or a drop-in Boat API. Its workloads are
containers inside hosts; it does not replace full-VM privileges, a desktop,
provider disk snapshots or an entire-host image. EC2/Hetzner API provisioning,
Daytona, Cloudflare Containers and Firecracker are extension targets, not supported
allocation adapters. An appropriately configured EC2/Hetzner Linux machine can be
explicitly adopted through SSH; those providers have not been performance-qualified.

See [illustrative costs and provider tradeoffs](docs/costs.md). One assignment per
host and permanent owner scoping mean these examples do not assume dense concurrent
packing or shared machines across customers.

## Optional native host backend

Python remains the default. An explicitly selected Rust backend preserves the same
provider/storage contracts. In a twenty-cycle matched Boat/R2 comparison, median
whole cycles were 13.45 s Python and 13.62 s Rust; both source-deleted recoveries
matched exactly. There was no consistent speed win. See the [measurements and
limits](docs/rust-host-benchmarks.md) and [native setup](host-rust/README.md).
The [instrumented follow-on](docs/host-stage-benchmarks.md) identifies filesystem
sync, runtime probes and storage publication costs; experimental buffering/batching
did not establish a repeatable end-to-end win.

## Runtime choice: Podman or gVisor?

Podman is the broad-compatibility default. Optional gVisor places a user-space
kernel between workload system calls and the host, adding defense in depth and
process checkpoint/resume. Both use the same host pooling, owner boundaries,
verified filesystem publication and checkpoint storage.

| Qualified capability                        | Default Podman backend                                    | Optional gVisor backend              |
| ------------------------------------------- | --------------------------------------------------------- | ------------------------------------ |
| Durable files and replacement-host recovery | Yes                                                       | Yes                                  |
| RAM/process continuity in Jetski            | Not implemented                                           | Same-host and opt-in portable memory |
| Runtime compatibility                       | Host Linux syscall interface, subject to container policy | gVisor's implemented Linux interface |
| Host implementation                         | Python or opt-in Rust                                     | Python; Linux x86-64, systrap        |

The **November 4 fairer comparison** used ten filesystem cycles per runtime,
two physical host pairs in reversed order, equal resources and working graceful
shutdown on both runtimes:

| Median                      |    Podman |    gVisor |
| --------------------------- | --------: | --------: |
| Resume to useful response   |    4.577s |    4.365s |
| Durable filesystem save     |    8.551s |    7.411s |
| New R2 body bytes per cycle | 1,880,957 | 1,880,957 |

Both source-deleted replacements matched exactly. Combined medians favored
gVisor, but the winning runtime changed between host pairs. Application stages
tell a different story: hashing and disk sync were close; gVisor metadata,
subprocess and loopback HTTP stages took about **4.6× / 9.7× / 3.0×** as long.
These are stage ratios, not whole-session multipliers. The older save comparison
was confounded by Podman's ten-second shutdown wait; both now offer a graceful
flush window. [Full fair comparison, local tests and limits](docs/runtime-fair-benchmarks.md).

Both runtimes also passed a local headed-Chromium/private-Xvfb demo with mouse
input, typed text and an identical screenshot. It used a trusted local page and
explicitly disabled Chromium's nested sandbox; it did not access the real desktop
or qualify arbitrary browsing. The [runtime-selection guide](docs/runtime-selection.md)
describes the opt-in gVisor-preferred bootstrap component and explicit fallback
permissions. Existing defaults remain unchanged.

The experimental [public-egress profile](docs/networking.md) adds filtered IPv4
internet to both runtimes. In twenty exact controlled-transfer cycles, the median
network workload took **2.83 s on gVisor / 3.64 s on Podman**; gVisor used more guest
CPU and memory and had slower DNS/first-request latency. [Full measurements and
qualification boundaries](docs/network-benchmarks.md) include the cold-start cost
and the passed source-deleted memory recovery and scoped deployed API trial. This does not change deployment defaults.

Embeddings can explicitly choose `gvisor-preferred`, with a permitted fallback
reason list, or require either runtime. Fresh-host selection freezes a candidate
before bootstrap and reports readiness only after native verification; errors
never trigger a weaker retry. A scoped deployed trial passed both normal gVisor
selection and operator-excluded Podman fallback, including durable warm recovery.
[Selection setup and qualification](docs/runtime-selection.md) explain the policy
and memory-required boundary. Existing deployment defaults remain unchanged.

Why keep Podman as default? It avoids making every workload depend on gVisor's
syscall compatibility and extra bootstrap/restore requirements. gVisor adds kernel
isolation, but can add syscall, filesystem/network and memory overhead. Our small
lifecycle fixture does not establish application-throughput superiority. Choose
gVisor explicitly for additional isolation or process continuity after checking
your workload. Podman also supports CRIU checkpoints upstream; Jetski's qualified
portable-memory implementation currently uses gVisor.
[Detailed tradeoffs and upstream sources](docs/runtime-comparison.md).

### Portable memory: latest measured comparison

The **November 4** run compares gVisor RAM transfer modes at the same verified
filesystem-plus-memory publication boundary: eighteen hosted cycles, three per
mode/profile, with a changing 64 MiB heap. These are not Podman comparison rows.

| Heap profile                       | Raw full save | Gzip full save | Gzip incremental save | New RAM bytes/save, raw → incremental |
| ---------------------------------- | ------------: | -------------: | --------------------: | ------------------------------------: |
| Small changes, compressible        |        65.76s |         42.71s |            **12.05s** |              64.19 MiB → **70.3 KiB** |
| Entire heap rewritten with entropy |        63.65s |         61.77s |                61.99s |                 64.20 MiB → 64.12 MiB |

The low-change case saved **81.7% of durable-save time** and reduced observed R2
body transfers from 66.0 to 1.9 MiB in each direction per cycle, including
files and verification readbacks. High-change entropy saw little benefit. Reuse avoids sending unchanged
chunks; native capture still reads complete memory images.

Both compressed-full and incremental checkpoints recovered process state after
physical source-host deletion: heap, token/counter, open-file cursor/content,
exact files/modes/links and retained output, followed by another save. The first
replacement exposed a permissions bug and required guarded repair; the second
passed automatically in **233.3s including provisioning and verification**.
This is compatible-host process recovery, not entire-host or external-connection
recovery. Preserve transactional metadata as well as checkpoint objects.

All eight test hosts were retired. Compute consumed $0.02093 of included credits
with **$0 wallet debit**. Retained test files plus RAM occupy 1.518 GB, about
$0.023/month of R2 Standard storage value before free allowances and billing-unit
rounding; this excludes request charges and is not an invoice.
[Full measurements, costs, failures and limits](docs/portable-memory-benchmarks.md).

To opt in, follow the [gVisor configuration guide](docs/gvisor-runtime.md), then
[portable memory setup](docs/portable-memory.md):

```sh
jetski suspend SANDBOX_ID --operation OPERATION_UUID --memory-codec gzip
jetski resume-memory SANDBOX_ID --operation ANOTHER_OPERATION_UUID
```

Observe each persisted operation to completion. Compatible runtime/image/helper
ABI, kernel and CPU features are required. An ordinary filesystem checkpoint does
not preserve processes; a failed or uncertain memory save cannot authorize release.

## Development and further reading

```sh
npm run build
npm run typecheck
npm test
npm run lint
```

Local unit tests need no cloud account. Hosted examples can create billable
resources; use explicit budgets and owned-resource cleanup. See
[design](docs/design.md), [qualification](docs/qualification.md),
[standalone configuration](docs/standalone.md), [implementation](docs/implementation.md)
and [MIT license](LICENSE).
