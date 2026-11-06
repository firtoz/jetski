# Implementation status

Jetski is an independent MIT-licensed sandbox runtime: a portable TypeScript
core/SDK, embedded Node controller, optional HTTP/SSH service and CLI. Read
[design](design.md) for contracts and [operations](operations.md) for deployment
boundaries. Main contains source APIs newer than published npm 0.1.1; pushing main
does not publish a package or change downstream deployments.

## Acceptance overview

| Area                  | Evidence and boundaries                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Independent package   | Portable subpath exports, prebuilt release checks and independent consumers.                                                     |
| Host/runtime adapters | Boat, SSH-managed Linux and optional boxd; rootless Podman and optional gVisor. See provider/runtime reports.                    |
| Execution and access  | Durable command identities, streaming output, PTYs, SSH, authenticated previews and forwarding.                                  |
| Checkpoint durability | Exact bytes/modes/links, atomic publication, reader/writer coordination, generation fencing and source retention on uncertainty. |
| Storage               | Local/S3 adapter contracts and R2 qualification; real-grace collection/recovery evidence is in qualification.                    |
| Memory recovery/forks | Compatible gVisor process continuation, explicit disk/RAM graph copies and independently writable targets.                       |
| Pool lifecycle        | One active assignment per host, owner-exclusive reuse, bounded leases, adaptive idle and one-shot preparation.                   |
| Current follow-up     | 406 TypeScript / 241 Python tests; actual three-way browser state and file checks; owned test hosts retired.                     |

Tests and live qualification have different scopes. Unit fixtures do not establish
provider performance, physical replacement, remote-store compatibility or all
possible workload isolation. Existing checkpoints remain retained; acknowledged
history is not silently expired. No new production cutover is included.

## Recent source changes

- Graceful viewer draining and stream preconditions before memory capture.
- Explicit `content: "memory"` copies, portable suspend and strict memory resume.
- One-shot prepared hosts, bounded parallel startup and multi-wave readiness.
- Durable per-object progress, bounded transfer concurrency and optional binary reads.
- Pinned-image cache reuse and checked Linux image durability barriers.
- Runnable TypeScript examples, including a recorded Chromium fork.

See [the application API](simple-api.md), [performance defaults](performance-tuning.md)
and [examples](../examples/README.md) for usage. The source additions are not yet
part of npm 0.1.1.

## Read selectively

- [Documentation home](README.md): user-facing guides.
- [Design](design.md): architecture, supported adapters and guarantees.
- [Qualification](qualification.md): conformance, recovery and limits.
- [Original runtime comparison](benchmarks.md) and [host lifecycle](host-lifecycle-benchmarks.md).
- [Provider parity](provider-parity-benchmarks.md): Boat/boxd behavior and measured tradeoffs.
- [Portable memory](portable-memory.md) and its [comparison](portable-memory-benchmarks.md).
- [Chromium preparation](chromium-fork-performance.md) and [transfer tuning](chromium-transfer-performance.md).
- [OpenAPI](openapi.json): implemented versioned operations.

Keep this page concise. Stable design belongs in the relevant guide, consolidated
measurements in reports, and routine execution receipts, budgets, provider IDs and
local recovery notes outside public source. Preserve consequential failures and
measurement limitations without checking in a transcript of every run.
