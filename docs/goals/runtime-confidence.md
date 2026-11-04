# Runtime confidence and fair comparison

## Objective

Compare Podman and gVisor fairly on owned Boat hosts and, where authorized and
supported, the operator's laptop. Fix observed deficiencies; evaluate an opt-in
gVisor-preferred, explicitly permitted Podman fallback policy versus Podman-only.
Include application work, filesystem durability, memory semantics and isolated
computer-use feasibility. No predetermined winning runtime or latency target.
Read and maintain `/home/frtn/work/2026/jetski/docs/goals/runtime-confidence.md`
after restart/compaction. Do not repeat completed matrices without a concrete defect.

## Finite acceptance

| Gate                    | Required evidence                                                                                                                                  | State    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Fair workload           | Equal pinned image/resources/network/storage, working SIGTERM, equivalent graceful stop; reversed two-host pairs                                   | Complete |
| Hosted measurements     | Five filesystem cycles/arm, four source arms; CPU, metadata, fsync, subprocess and loopback throughput; lifecycle stages, bytes/requests/resources | Complete |
| Recovery                | Two physical source-deleted replacements, exact bytes/modes/links/output; reuse prior unchanged RAM qualification                                  | Complete |
| Selection policy        | Explicit required capabilities, persisted decision/reason; no silent isolation downgrade or post-command retry                                     | Complete |
| Laptop and computer use | Capability inventory; isolated existing-Podman tests; gVisor bundle only after explicit operator override; document GUI/browser boundary           | Complete |
| Report                  | Per-host deltas and variation, limitations, actual cost/cleanup; concise selection recommendation                                                  | Complete |

## Constraints and budget

User separately authorized up to **$5** of existing Boat wallet, no top-up. Maximum
ten small one-hour hosts: four matched sources, two replacements, two optional
computer-use compatibility sources and two failure reserves. Even the conservative
$0.07/start + $0.036/hour reservation totals $1.06; fresh provider quotes can refuse
allocation if the actual aggregate would exceed $5. No other budgets/GC fixtures.
First sources double as capability preflight. Preserve failures, IDs and receipts.
Keep acknowledged checkpoint/fencing/publication/reader-writer/pin/GC guarantees.
No cross-owner reuse, snapshots, client/production cutover or desktop services,
privileged host mounts/devices, session changes, global runtime defaults or top-ups.
Do not grant a real desktop connection as a side effect of a container GUI demo.
No subagents. Public content generic. User authorized committing and pushing this completed work to main on November 4.
No active app goal was requested/created; this scratchpad preserves the task.

## Current state and recovery

Implementation, finite qualification and report consolidation are complete,
without a deployment/default/client switch.
Repo `/home/frtn/work/2026/jetski`, main, base `6521165`; publication to main is authorized. Private evidence `/home/frtn/.local/state/jetski-qa/runtime-confidence-20261104/`:
`budget.json`, `current.json`, `benchmark/report.json`, `benchmark/final-audit.json`,
`benchmark/metadata-audit.json`, `benchmark/retention-audit.json`, and `local/` receipts.
The controller session 24813 exited zero; never restart it or allocate more hosts.

Twenty hosted and twenty local samples pass. Both physical source-deleted
filesystem replacements match exact files/modes/links/original output and save
again. Fresh six-host provider404 and complete empty active inventory pass.
Four stopped sandboxes retain roots with no lease, pending operation or actors.
All owned local containers/scopes/runtime processes are absent. Six starts reserve
$0.636 of the new $5 cap; $0.00703 observed included compute value, $0 wallet debit,
with a conservative tail upper bound bringing value to at most $0.00710.

User explicitly approved the private pinned local bundle and disposable limited
containers. Both headed Chromium/private-Xvfb mouse/key/screenshot demos pass,
with identical PNGs. The initial cgroup bypass failed resource enforcement and
was rejected; accepted runs prove limits in an outer transient user scope.
Podman NoCgroups rejection and host-copy failure for a gVisor virtual file remain
preserved; runtime exec transferred the PNG with matching bytes/hash. No desktop
session/global service/runtime default was changed. Binaries/images remain cached.

The [fair comparison](../runtime-fair-benchmarks.md) preserves mixed pair results,
roughly equal hashing/sync and substantial syscall-heavy gVisor costs. Graceful
SIGTERM parity replaces gVisor's prior hard-kill. Opt-in [selection](../runtime-selection.md)
components persist a runtime choice, check required capabilities, allow only
operator-approved unsupported-capability fallbacks, refuse unknown support and
never rebind a host or replay uncertain execution. Six affected tests include a
real SQLite reopen. No automatic admission probe or standalone preference default
is implied: embeddings supply trusted checks; bootstrap still proves its policy.

Current gVisor adapter supports network `none` and Python hosts only. Qualified
egress is a future adapter extension, not an intrinsic gVisor limitation. Real
laptop host adoption and arbitrary untrusted browsing remain outside this local
component/demo evidence. Reuse existing unchanged portable-RAM qualification.

Final build/typecheck/lint/Ruff pass, with 340 TypeScript and 217 Python tests;
changed public terminology and relative links pass. Publication is authorized; observe exact-commit CI after pushing. No further
qualification or host allocations remain.
