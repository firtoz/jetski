# gVisor outbound networking and scoped preference trial

## Objective

Implement modular rootless outbound networking for the optional gVisor runtime,
qualify real workloads and safe recovery, compare fairly with Podman, then complete
a scoped staging gVisor trial. The first online client trial requires gVisor
explicitly; the optional preferred/fallback composition remains available without
a global default change. Read and maintain
`/home/frtn/work/2026/jetski/docs/goals/gvisor-egress.md` after restart/compaction.
Preserve acknowledged files/process checkpoints, exact bytes/modes/links,
publication verification, fencing, reader/writer coordination, pins and GC.
No automatic global default change or production cutover. Do not weaken isolation
or replay uncertain work to obtain a faster result.

## Finite gates

| Gate                           | Required evidence                                                                                                                                   | State   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Network design and capability  | Private caller-managed namespaces, pinned netstack, bounded lifecycle and effective resource enforcement                                            | Passed  |
| Integration                    | Versioned operator policy; bootstrap, execution, namespace cleanup, SDK admission and required-capability checks                                    | Passed  |
| Network behavior and isolation | DNS/HTTPS, Git/package-download/browser tasks; host/private/metadata denial; explicit IPv6 support or refusal                                       | Passed  |
| Recovery                       | Same-host suspend/resume and source-deleted R2 memory/filesystem recovery with actual reconnect, original output and exact fixture                  | Passed  |
| Fair comparison                | Two reversed host pairs, five cycles per runtime/source; same image/resources/network policy; request latency, throughput, CPU/memory and lifecycle | Passed  |
| Scoped staging                 | New workspaces only, explicit gVisor preference, observed runtime/fallback reason, useful internet task and stopped recovery                        | Pending |
| Closure                        | Consolidated evidence, source checks, cost reconciliation and positive owned cleanup                                                                | Pending |

Implement before broad qualification. The first matched source may double as a
capability preflight. Preserve failures and original IDs; repeat only affected
checks after concrete fixes. No expanding unchanged verification matrices or new
model/PR workflows unrelated to networking. No subagents.

## Authorization and constraints

User separately approved up to **$5**, existing Boat wallet only, no top-up, on
November 4. At most twelve small one-hour hosts, covering four matched sources,
controlled network fixture(s), physical replacements, scoped staging and bounded
failure reserves. Check quotes and reserve before allocation. Previous budgets,
protected fixtures, histories and GC experiments remain untouched. Do not allocate
for connectivity alone; reconcile owned jobs/inventory first. No snapshots.

Local authorization persists for a private pinned runtime bundle and disposable,
resource-limited containers. No global desktop runtime/service/network changes,
host display/profile/credential/input-device mounts, privileged desktop helpers
or operator toolchain installs. Use existing local binaries; missing prerequisites
move native qualification to disposable Boat/CI hosts rather than installing them.
Public source/docs/commits stay generic; client integration belongs client-side.
Use the standing main/publication authorization for the pinned artifact and
scoped staging milestones. No npm publication or production cutover.

## Current state and next action

Main base `63d33fd`; source/docs are uncommitted. Private evidence:
`/home/frtn/.local/state/jetski-qa/gvisor-egress-20261104/` (`budget.json`, `current.json`).
Ten hosts have been used and positively retired, including four failed setup
attempts. No further backend matrix is needed. The twenty exact network cycles,
local Git/package/browser components, native packet denial, warm memory resume
and source-deleted R2 memory/filesystem recovery all pass. See the
[consolidated report](../network-benchmarks.md) for measurements and limitations.
Temporary transfer fixtures are deleted; acknowledged checkpoint roots remain.

The new explicit `public-egress` policy shares filtered IPv4 networking between
Podman and gVisor. It verifies a trusted keeper, namespace identity/maps, kernel
filter and read-only resolver; public IPv6 is refused. Podman's public profile
shares the engine-private user namespace with the keeper and verifies the actual
mapped workload identity after launch. No outer host user namespace is exposed.
Default profiles and existing host policies remain unchanged.

Four concrete failures were preserved and fixed: sterile nft PATH / native flag,
missing device in kernel JSON, resolver permissions and Podman's nested-userns
sysctl conflict. The first five gVisor rows are reused across a Podman-only fix;
its executed path is unchanged and the artifact boundary is explicit. Do not
replay old failures or repeat passing matrices. Latest source checks are recorded
in private receipts; repeat only affected tests and the final publication checks.

Next: publish the qualified runtime milestone and pinned prerelease artifact,
complete the new-scope client integration and one bounded staging trial, then
consolidate exact-SHA CI, budget and cleanup. At most two host starts remain in
the separately approved twelve-start / $5 allowance. Prefer one staging host with
warm stopped recovery, leaving one failure reserve. Existing client controllers
must keep their admitted policy; use a new disposable scope and fixed one-hour
leases. The protected client GC document/reservation stays untouched.

The first client trial uses **gVisor-required**, rather than silently downgrading
an uncertain host or workload. This refines the trial's admission strategy; it
does not remove the general preferred/fallback API or enable automatic defaults.
Public source remains generic; client details stay in the client repository.
