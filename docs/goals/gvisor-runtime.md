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

| Gate                       | Required evidence                                                                                                                      | State       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Contract/design            | Explicit runtime/bootstrap capabilities; suspend/stop distinction; memory/filesystem consistency and fallback contract                 | In progress |
| Native runtime integration | Pinned runsc installation on owned execution hosts; lifecycle/exec/files/PTY/forwarding through trusted adapter                        | Open        |
| Memory integration         | Real process-memory continuity with exact files; verified R2 root before acknowledgement/release; fenced compatible resume             | Open        |
| Targeted failure coverage  | Restart/lost ACK, stale/mismatched/missing/corrupt memory, output identity, uncertain source retention and cleanup                     | Open        |
| Matched benchmark          | Podman filesystem / gVisor filesystem / gVisor memory; two reversed groups, five timed cycles per mode per group: thirty valid samples | Open        |
| Durable recovery           | One source-deleted R2 replacement per runtime; exact files/modes/links/original output; explicit memory-loss fallback                  | Open        |
| Report/publication/cleanup | Stage timing, CPU/RSS scope, bytes/requests, cold/warm readiness, costs and failures; owned absence and main CI                        | Open        |

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
Approval recorded in private `budget.json`; no allocation made yet. Local implementation proceeds first.

Workspace `/home/frtn/work/2026/jetski`, main `b12800a`, clean at goal start.
Prior stage-performance goal is complete; all ten owned hosts were provider404
and final CI passed eight jobs. Its data/budget are read-only reference evidence.
Private state: `/home/frtn/.local/state/jetski-qa/gvisor-20261103/`.
No host or controller allocated for this goal yet. No runsc installed on desktop.

## Current implementation

The [runtime design](../gvisor-runtime.md) records the contract. Native Python
bootstrap/control/exec selection is implemented, including operator workload init
for both runtimes without changing defaults. Private memory freeze/seal/resume
bind physical inode/link identity, original native checksums, exact archive bytes
and verified publication. Successful RAM resume retires only the derived old tar
so subsequent changed saves can reuse the assignment safely.

Managed SDK/server suspend and resume use durable filesystem transfer/verification,
exclusive physical successor reservation, separately fenced core generations and
retained-root holds. Known pre-effect failures explicitly fall back to filesystem
placement; uncertain native effects retain/quarantine source. Pool release and
fallback transition commit together. SDK/HTTP/CLI and standalone Boat policy expose
the optional path; per-sandbox runtime capability discovery is implemented.

Local build/typecheck/lint and Ruff pass; 297 TypeScript and 180 Python tests pass,
including lost seal/resume ACK, restart, uncertain-source retention, known memory
failure and absent-source fallback. These are composition checks, not native proof.
CI `85a5d52` passed all eight existing jobs. The new native job first found a real
bootstrap bug under permissive umask: a newly created trusted parent inherited777.
Explicit creation fixes it. Native bootstrap passes. Bounded native diagnostics identified two launch
constraints: default overlay conflicts with shared files, and runsc configures
cgroup controllers above the delegated subtree. Explicit overlay disable and
trusted host-managed cgroup limits/entry address these without allowing workloads
to change limits. Actual launch and new cleanup paths still need native proof.
No Boat allocations, controller, native desktop execution or wallet spend.

## Next actions

1. Diagnose the actual native launch error on disposable CI; do not weaken
   namespace, filesystem or resource protections. Qualify the new cleanup path.
2. Complete targeted native CI qualification for the new runtime path, then freeze
   artifact/workload. Adapt the stale private capability helper to the actual
   concrete environment before using the first approved matrix host.
3. Complete the single matched comparison, both source-deleted recoveries, owned
   cleanup, honest report and final exact-SHA publication. No repeated baseline matrix.
