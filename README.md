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
  scheduling, identity, transport and observability adapters. Importing `jetski/core`
  or `jetski/sdk` does not load SSH servers, SQLite or provider SDKs.
- **Use familiar interfaces:** command execution, files, PTYs, SSH access,
  authenticated HTTP/WebSocket previews and TCP forwarding.

Workloads use rootless Podman, **one active assignment per host**, with no
cross-owner host reuse. Filesystem checkpoints preserve declared persistent paths
(`/workspace` and `/home/sandbox`), including bytes, modes, symlinks and hardlinks.
They do not preserve RAM, running processes, kernels or arbitrary host files.

## What we measured

These are two separate comparisons with different controllers and workloads;
**do not combine their percentages into one speedup**.

| Warm checkpoint comparison, ten trials per arm | Reference median | Optimized Jetski median |
| ---------------------------------------------- | ---------------: | ----------------------: |
| Durable save and release                       |          4.923 s |             **2.499 s** |
| Resume readiness                               |          2.018 s |             **1.104 s** |
| Work/save/resume/independent verification      |          8.034 s |             **4.933 s** |
| Changed payload uploaded                       |         1.042 MB |            **0.263 MB** |

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

Use the Node version in [`.nvmrc`](.nvmrc). From a checkout:

```sh
npm ci
npm run build
```

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
node dist/cli.js serve --config /absolute/path/server.json
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
| Workload runtime         | Rootless Podman                                                      |
| Checkpoint store         | Local filesystem; S3-compatible; native R2 binding for embeddings    |
| Transactional state      | SQLite for Node; injectable `StateStore`                             |
| Scheduling               | Standalone worker; injectable platform scheduling                    |
| Identity / observability | Owner-scoped bearer auth, gateway keys; injectable policy/event sink |

For npm clients before publication, pin a reviewed full Git commit:
`npm install git+https://github.com/firtoz/jetski.git#<full-commit-sha>`.
The prepare hook builds JavaScript and declarations. Bun consumers should use a
built release `.tgz` pinned by URL and lockfile digest, with lifecycle scripts
disabled; Git-source preparation is not qualified for Bun.

Embedded clients compose `SandboxManager` from `jetski/core` and supply state,
provider, host transport, storage and scheduling. No standalone service is required.
`jetski/host-assets` supplies bundled bootstrap source without filesystem reads;
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

## Optional gVisor runtime

Keep the same host and storage adapters while selecting a gVisor user-space kernel
instead of Podman execution. Opt-in memory suspension preserves application RAM
on a compatible retained host; verified R2 checkpoints remain the independent
filesystem recovery path. Podman stays the default.

In a thirty-sample Boat comparison, median resume-to-response was **5.74s Podman**,
**4.54s gVisor filesystem**, and **4.27s gVisor memory**. Memory continuity and both
source-deleted **filesystem** R2 recoveries passed exact checks. Cold setup and memory overhead
were higher; save results depend on shutdown policy. See [measurements and limits](docs/gvisor-benchmarks.md)
and [configuration, API usage and recovery semantics](docs/gvisor-runtime.md).


### Portable memory checkpoints

Opt-in memory saves can also survive loss of the original Boat: store verified
RAM chunks with the matching filesystem checkpoint, then restore on a compatible
host. Both compressed-full and incremental source-deleted recoveries preserved the
changing 64 MiB heap, process token/counter, open-file cursor/content, exact files
and retained command output, then saved again. The first recovery exposed a parent
permissions bug and needed a guarded repair; the second passed automatically.

In the low-change workload, median durable saves were **65.8s raw full**, **42.7s
compressed full** and **12.1s compressed incremental** (three cycles per arm).
High-change entropy offers little compression/reuse benefit. See the
[comparison and limits](docs/portable-memory-benchmarks.md) and
[configuration/API guide](docs/portable-memory.md).

```sh
node dist/cli.js suspend SANDBOX_ID --operation OPERATION_UUID --memory-codec gzip
node dist/cli.js resume-memory SANDBOX_ID --operation ANOTHER_OPERATION_UUID
```

Observe each persisted operation to completion. Compatible runtime/image/helper
ABI, kernel and CPU features are required; keep the transactional metadata as well
as the checkpoint objects. This preserves declared process/filesystem state rather
than an entire host or external network sessions. Podman remains the default.
