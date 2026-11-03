# Optional gVisor runtime and coordinated memory resume

## Full objective and constraints

Implement an optional gVisor runtime backend and benchmark it against Podman,
including memory checkpoint/resume with R2 as independent durable filesystem recovery.
Read and maintain `/home/frtn/work/2026/jetski/docs/goals/gvisor-runtime.md` at the
start of every continuation and after compaction; pursue the complete finite scope.
Machine provider, runtime and storage remain independent. No mandatory managed-sandbox service.
Podman remains default; existing hosts, clients and retained checkpoints remain intact.
Start with Python host composition; reject unsupported Rust/runtime selections.

Acknowledged checkpoints must preserve bytes, modes, symlinks and hardlinks. Keep
immutable host/runtime identity, stable operation/command IDs, uncertain-execution
semantics, leases/generation fences, verified remote publication/cache reuse,
reader/writer coordination, pins and fail-closed GC. Failed/unknown saves retain
and quarantine source. No competing writers or blind command replay. This is not
an absolute guarantee against every failure or uncheckpointed-write loss.

Memory images must bind the exact stopped filesystem generation and runtime/image/
configuration/host compatibility identity. A fast image never authorizes bypassing
R2 publication or using mismatched files. Keep existing filesystem checkpoint/stop
semantics stable; expose capability-gated memory suspend rather than killing tasks
then claiming RAM preservation. Missing/incompatible/stale/corrupt memory must be
refused and fall back explicitly to verified filesystem recovery, disclosing lost
process state. Closed/missing TCP sessions must not be resurrected as successful.

No subagents, desktop runtime/toolchain installation or reconfiguration, provider
snapshots, cross-owner reuse, default/client cutover, npm publication or top-ups.
Prior funds, protected fixtures and sibling client files stay untouched. Public
source/docs/commits stay generic. Existing session authorization covers coherent
main milestones; final exact-SHA CI and concise reporting are required.

## Finite acceptance matrix

| Gate                       | Evidence                                                                                                | State    |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | -------- |
| Contract/design            | Runtime/bootstrap capabilities, stable suspend/stop and fallback contract                               | Complete |
| Native runtime integration | Owned-host pinned runsc; native lifecycle, binary execution, PTY, TCP and enforced resources            | Complete |
| Memory integration         | Full evolving 64 MiB heap continuity; exact files, fenced successor, verified R2 publication            | Complete |
| Targeted failure coverage  | Restart/lost ACK, stale/missing/incompatible/corrupt memory, uncertain-source retention                 | Complete |
| Matched benchmark          | Two reversed groups, five cycles per mode per group: thirty valid samples                               | Complete |
| Durable recovery           | Source-deleted Podman and gVisor R2 replacements; exact files/modes/links/output and explicit RAM loss  | Complete |
| Report/publication/cleanup | Consolidated report; fresh eight-host absence, empty inventory, stopped metadata, wallet reconciliation | Complete |

Implement coherently before broad hosted qualification. Complete affected checks,
freeze sources/artifacts/workload, then run one finite matrix. No predetermined
speed target, repeated unchanged matrices or extra model/browser/PR workflows.
Preserve failures/IDs; rerun only an affected failed check after a concrete fix.
If host capabilities cannot support gVisor safely, fail closed and report the
concrete constraint; do not quietly substitute another isolation runtime.

## Budget and recovery context

Separate allowance approved by the user: up to $3 from existing Boat wallet, no top-up;
at most ten small one-hour hosts: six matrix arms, two source-deleted replacements,
two failure reserves. Capability preflight uses the first owned matrix host, not
an extra connectivity VM. Worst-case reservation at $0.07/start plus $0.036/hour
is $1.06; reconcile actual size-weighted compute, start quotes and wallet separately.
Approval recorded in private `budget.json`. Eight starts were used; all eight
are provider404, complete active inventory is empty, actual wallet debit is $0.00
under included credits. Compute value is $0.01119–$0.01129; no additional hosts
are needed. Prior budgets and retained histories remain untouched.

## Current implementation and evidence

The [runtime design and usage](../gvisor-runtime.md) records configuration,
capabilities, memory/filesystem identity and fallback behavior. The
[consolidated benchmark](../gvisor-benchmarks.md) records timings, stage breakdown,
resources, requests, retained bytes, costs, failures and limitations.

Local build/typecheck/lint and Ruff pass, with 297 TypeScript and 187 Python tests.
Native CI covers binary execution, PTY/TCP, full-heap continuity, exact local
recovery and cleanup. The frozen Boat candidate is `741759b`; its runtime bundle
is identical to the qualified `d07f0b3`. All thirty hosted rows and both independent
source-deleted R2 replacements pass. Six controller process restarts preserve
operation identity. All six sandboxes finish stopped without leases, pending
operations or checkpoint holds. Acknowledged R2 histories remain retained.

Two harness faults are preserved with original IDs and completed rows: a fixture
root invocation before writes, and a usage query after successful source deletion.
Neither required an extra start or repeating the completed matrix. Podman's
ten-second shutdown grace materially affects the save comparison. Total network
bytes are unavailable because signed host transfers bypass controller counters;
retained frame bytes and request scope are reported separately.

## Recovery context and next actions

Workspace `/home/frtn/work/2026/jetski`, branch main. Private state:
`/home/frtn/.local/state/jetski-qa/gvisor-20261103/`.
Read `current.json`, `benchmark/completed.json`, `benchmark/report.json`,
`benchmark/supplemental-metrics.json`, `benchmark/final-audit.json` and
`benchmark/metadata-audit.json` selectively. Controllers are terminal; do not restart
or allocate. No desktop runtime was installed and no client/default cutover occurred.

All acceptance gates pass. [CI for runtime/report revision `76f531b`](https://github.com/firtoz/jetski/actions/runs/41740138293)
passed all nine jobs, including native gVisor, the installed API and its referenced-
timer cleanup assertion, SSH/Boat compositions and browser previews. The final
repair clears an SSH terminal lifetime timer in its owning task's `finally`;
no benchmark or acknowledged checkpoint was changed. Build/typecheck/lint and
ten affected SSH/terminal tests also pass locally.

The implementation and qualification are complete. Podman remains default;
there is no client cutover. All owned hosts are absent and retained R2 roots are
preserved. No further hosted runs are planned. This closure record is documentation
only; final main checks remain visible on the repository's current revision.
