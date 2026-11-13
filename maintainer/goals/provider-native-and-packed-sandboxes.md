# Goal: provider-native machines and packed sandboxes

Status: proposed implementation; no new capability is implemented or qualified by
this document. Baseline: Jetski 0.3.0, commit
`d730155139903e023c7e7412235b1c16aeb025ef`. Verify the checkout before relying on it.

Handoff validation: local build, typecheck, lint, document links and all 417 tests
passed with Node 24.22.1 and npm 11.4.2. No hosted resources were launched. These
checks validate the unchanged baseline plus this handoff, not the open goal gates.

## Continuation instructions

At the start of each continuation and after compaction, resolve this file against
the checkout root and read its **absolute path**. Pursue the full objective below,
maintain the acceptance matrix and replace current status in place. Do not rely on
the originating conversation. Read `AGENTS.md`, [implementation](../implementation.md),
[design](../design.md) and [testing](../testing.md) before changing implementation.
Keep stable implemented contracts in design, supported scope in implementation,
and consolidated evidence in [qualification](../qualification.md). Keep routine
receipts, resource identities and recovery handles in private local QA notes.

Fallback objective: evolve the existing Jetski API so a developer can start a
provider-native VM or an isolated child on reusable provider compute, choose
supported snapshot storage independently, and eventually pack multiple microVMs
on each host, with explicit capabilities and verified lifecycle/recovery.

## Intended outcome

A developer's familiar start/execute/files/observe/stop workflow should support:

1. **Provider-native use:** start a Boat or boxd machine, use its supplied tools,
   browser and native facilities, then stop or delete it with explicit semantics.
   Do not require a Jetski workload runtime or checkpoint store for this path.
2. **Jetski-managed persistence:** use provider compute with snapshots in storage
   the operator controls instead of relying on additional provider saved snapshots.
   Describe exactly what survives. Supporting a native machine's installed
   packages/system configuration needs broader capture/restore than today's
   workspace checkpoint. Do not silently narrow this objective to two directories.
3. **Sequential reuse:** release one isolated child and start another on the same
   warm host, reducing provider starts while independently disposing of children.
4. **Concurrent packing:** run multiple isolated children on one host, with bounded
   CPU, RAM, disk, processes and networking and independently fenced lifecycles.
5. **MicroVM execution:** support real guest kernels on capable hosts. A target
   scenario is 50 child instances on 10 provider VMs, five per host, when the
   measured workload and host sizes fit. This is a qualification target, not a
   fixed density, throughput or cost promise.

Keep these choices distinct: provider; execution boundary (native VM,
container/gVisor, microVM); snapshot backend/coverage; dedicated/shared placement;
warm retention. Reject unsupported combinations before allocation where possible.
Use the existing `/node`, `/sdk`, shared session and advanced adapter hierarchy;
extend it coherently rather than creating a competing convenience framework.
Preserve released behavior unless an explicit versioned migration is necessary.
Treat native-machine access as the simple entry path without silently changing
existing managed-sandbox defaults or isolation guarantees.

## Current implementation and gaps

- `runSandbox()` and `openJetski()` normally prepare a Jetski workload runtime on
  provider compute. The default is rootless Podman, not a native full-VM shell.
- `BoatMachineProvider` in `src/providers/boat.ts` offers allocation, owned
  inspection and retirement without runtime attestation. It is not a complete
  native session API: allocation disables account environment injection, provider
  snapshots and monitoring; retirement deletes rather than offering native stop.
  Preserve credential isolation while reviewing provider-native feature access.
- `BoxdHostProvider` in `src/providers/boxd.ts` combines lifecycle with bootstrap;
  extract a clean machine-only boundary without weakening ownership checks.
- Warm sequential reuse exists. One active assignment per physical host and no
  cross-owner reuse are current invariants. Concurrent packing needs an explicit
  reviewed change across scheduling, authority, host execution and cleanup.
- Verified filesystem checkpoints cover `/workspace` and `/home/sandbox`.
  Compatible gVisor RAM/filesystem recovery exists separately. Neither is a
  whole-provider-machine snapshot or a real microVM backend.
- Provider browser binaries/profiles/desktops live outside inner workloads unless
  explicitly integrated. Do not claim browser equivalence or portable browser
  process state simply because execution shares an outer host.

## Design constraints

- A provider-ready machine and a verified managed runtime have different meanings.
  A direct native user with root on the parent must have a dedicated parent; it
  cannot safely share that parent with other isolated workloads.
- Begin shared placement within one owner. Cross-owner packing is outside this
  goal; do not weaken the existing owner isolation/no cross-owner dedup guarantees.
- Separate child identity/generation/lease from parent allocation and capacity.
  Persist placement/resource reservations transactionally before effects. Fence
  stale commands, saves, routes and cleanup independently for each child.
- Stop/checkpoint, release of execution, deletion of retained history and retirement
  of a parent are distinct. Preserve acknowledged history and explicit pins.
  Verify saves before release; unknown or failed saves retain recoverable sources.
- Dispose must account for descendants, detached processes, disks/mounts, network
  namespaces, forwarding routes, credentials and reservations. Reuse only after
  verified cleanup. Retire/drain a parent only after its children are reconciled.
- Handle parent expiry/loss as a correlated failure of its children. Arrange
  sufficient drain time; a provider timer alone cannot guarantee a final save.
  Reconcile restarts and lost acknowledgements without blindly replaying effects.
- Preserve exact acknowledged bytes/modes/links, immutable verified publication,
  generation fencing, reader/writer coordination, quarantine, complete reachability,
  fail-closed collection and the minimum 24-hour GC grace.
- Native snapshot replacement must specify base-image identity, captured paths and
  deletions, ownership/xattrs as required by the contract, quiescence/consistency,
  bootstrap/services and restoration to a fresh machine. Decide explicitly whether
  each backend supports filesystem recovery, process memory, or both. Do not call
  a file archive a whole-machine snapshot. Preserve metadata as well as objects.
- Shell, files, terminals, ports, browser, root, Docker, systemd and KVM need a
  capability matrix. Provider-specific access should remain available without
  pretending all execution boundaries offer the same facilities.
- Inspect browser binary, launcher, profile, display and egress configuration.
  Distinguish driving the provider browser from running a browser inside a child;
  any bridge needs scoped authentication and an explicit isolation/state boundary.
  No universal bot-detection bypass claim, and no copying personal browser profiles.
- Quantify physical provider starts, child starts, concurrent capacity, retained
  host time and storage/transfer costs separately. Warm time can outweigh avoided
  starts; packing cannot manufacture CPU or RAM. Enforce configured caps rather
  than treating a pricing estimate as a spending guarantee.
- Keep provider/storage credentials controller-only, core/SDK imports portable,
  images/runtime artifacts pinned, and authorization/scheduling/storage injectable.

## Phases and acceptance

All gates are open. Work in reviewable phases, update this table with evidence
paths, and keep later gates open when completing an earlier slice.

| Gate                                 | Required evidence                                                                                                                                                                                                                           | Status                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| A. API and capability design         | Concrete native/managed examples; independent policy choices; supported combinations and migration; lifecycle/expiry consequences; updated design and implementation matrices                                                               | Open                                 |
| B. Native Boat and boxd              | Installed-package create/exec/files/observe/stop/delete examples; no managed-runtime bootstrap requirement; preserved provider features; ownership, retry/uncertainty and cleanup checks                                                    | Open                                 |
| C. Jetski snapshot storage           | Defined native-machine and child capture boundaries; independent fresh-machine restoration oracle covering acknowledged state, packages/config where claimed; corrupt/missing-object and failed-save cases; separate metadata backup recipe | Open                                 |
| D. Sequential reuse                  | Several fresh children on fewer provider allocations; exact state isolation; detached-process/network/access cleanup; idle retirement, restart and uncertain-cleanup evidence; measured starts/host time                                    | Existing foundation; acceptance open |
| E. Concurrent packing                | Same-owner capacity ledger and scheduler; simultaneous distinct children; CPU/RAM/disk/process/network limits; independent stop/save/delete; overload rejection; child/parent races, failure and drain evidence                             | Open                                 |
| F. Real microVM backend              | Qualified KVM host, pinned guest kernel/rootfs/VMM; execution, networking, storage, cleanup and declared restore semantics; incompatible-host rejection; existing runtime behavior retained                                                 | Open                                 |
| G. Browser and feature parity        | Native vs child feature matrix; actual browser identity/profile/egress and authenticated interaction checks; browser state recovery only where demonstrated                                                                                 | Open                                 |
| H. Density and cost                  | Bounded approved live matrix reaching 50 children on 10 hosts if capacity permits; declared workload, sizes, contention/latency/memory and starts/host-time/storage accounting; observed cleanup of every allocation                        | Open; needs allowance                |
| I. Integration and release readiness | Build/tests/lint/typecheck, focused conformance and recovery suites, fresh packed consumers and portable bundles; concise runnable guides/examples; changeset and compatibility notes                                                       | Open                                 |

Local mocks close local contract cases only. Hosted/native capability gates need
actual scoped evidence. If a target fails, record the failure and remaining work;
do not redefine the target or substitute a simulated density result.

## Machine setup and credentials

Use a checkout of the full repository plus this document. No old controller state
or provider keys are necessary to begin design, implementation and local tests.
Use Node **24.22.1** (`.nvmrc`), npm **11** and Git; run `npm ci`. npm 11.4.2 was
verified here; npm 12.2.0 failed the existing package-artifact JSON assertion.
Python/native toolchain
requirements depend on the affected code: consult `maintainer/testing.md` and
`.github/workflows/ci.yml`. Keep Podman/gVisor/KVM installation and privileged
qualification on explicitly disposable execution hosts/runners, not an operator
desktop. A long-lived development machine is not automatically disposable.

For later authorized live tests, supply only the relevant entries below in a
private environment file outside the checkout. These are existing example names,
not a new configuration loader; source the file explicitly in the agent's shell.

```sh
# Boat compute; not needed for local development.
export BOAT_API_TOKEN='REPLACE_WITH_SCOPED_PROVIDER_TOKEN'
# boxd compute; optional until testing that provider.
export BOXD_API_KEY='REPLACE_WITH_ORGANIZATION_SCOPED_KEY'
# Managed workloads: an approved digest-pinned image, not a mutable tag.
export JETSKI_IMAGE='REGISTRY/IMAGE@sha256:REPLACE_WITH_APPROVED_DIGEST'
# Optional R2 qualification; local checkpoint storage works without these.
export R2_ENDPOINT='https://ACCOUNT.r2.cloudflarestorage.com'
export R2_BUCKET='EXISTING_PRIVATE_QUALIFICATION_BUCKET'
export R2_ACCESS_KEY_ID='REPLACE_WITH_BUCKET_SCOPED_ACCESS_KEY'
export R2_SECRET_ACCESS_KEY='REPLACE_WITH_SECRET'
```

Also supply nonsecret provider account/organization, boxd namespace/region where
used, storage prefix and approved image/runtime identities. Namespace/region and
prefix are configuration fields, not automatically recognized environment names.
Use an isolated fresh controller directory, pool/owner identity and storage prefix
for each experiment. Never point qualification at production state or a broad
bucket cleanup target. Verify private registry pull access only if needed.

The standalone service is optional. Its existing configs use `JETSKI_API_TOKEN`;
SDK examples use `JETSKI_URL` and `JETSKI_TOKEN`. Generate separate test credentials
if testing that route. No npm publication token, personal browser login, Voxl
artifact, model-provider key or desktop recording setup is required for the basic
goal. The advanced existing browser demo has its own optional prerequisites;
read `examples/07-memory-fork/README.md` only if using that harness.

Inspect `examples/qualify-live-boat.ts` before using it. Its
`JETSKI_PAID_QUALIFICATION_APPROVED=1` check is a mechanical guard, **not** spending
permission. Other examples may allocate without that guard. Do not set approval
flags or run allocating examples before an explicit scoped allowance exists.

## Authorization and transfer

The originating request authorizes writing this repository goal/handoff. It does
not grant a new live budget, consumer migration, production change, publication,
or permission to install execution runtimes on an operator desktop. The receiving
agent should obtain its implementation instruction from the user and can then
make progress on local work without provider credentials. The user authorized
committing and pushing this handoff to `main`; that does not authorize publishing
an implementation release. Instructions from an earlier completed task are not a
standing allowance for this goal. Do not publish secrets in commits, logs or chat.

Before live testing, the user must supply an allowance specifying: provider and
account; total incremental spending cap/currency; maximum concurrent parent VMs;
allowed sizes/regions; expiry and wall-clock deadline; allowed storage/transfer
charges and prefix; and whether existing credits may be consumed. Start with the
smallest discriminating live case; the 10-host density experiment needs its own
sufficient allowance. Keep cleanup/reconciliation within the test plan and record
any uncertain residual resources privately for follow-up.

Transfer the handoff with the code: this file and its maintainer index link must
exist in the receiving checkout. An uncommitted file will not arrive via pull;
copy the changes manually or commit/push under a fresh instruction. Provider
credentials are separate from source access; use the other machine's own GitHub
authentication rather than copying the laptop's entire credential directory.
For fresh development do not copy `.jetski/`, SQLite, snapshots or live process
handles. Moving an existing controller is a separate recovery operation requiring
metadata/objects/configuration and a stopped authoritative writer.

## First actions and completion

1. Read this file and the current code; verify branch, worktree and baseline. No
   resources were launched for this handoff and there is no live job to resume.
2. Write a concise design for the independent choices and API compatibility. Start
   with native Boat/boxd lifecycle separation; assess current provider API drift.
3. Run local baseline checks, implement phase B with focused recovery/ownership
   cases, and proceed through the remaining gates. Lack of a live allowance blocks
   live tests, not independent design/local implementation work.
4. Use `npm run build`, `npm run typecheck`, `npm test` and `npm run lint` after
   changes. Run relevant native suites and CI's pinned Python formatter for Python
   changes. Run installed-package and release checks per `maintainer/testing.md`;
   reuse unchanged qualification rather than repeating every old experiment.
5. User-facing implementation changes need a changeset (`npm run changeset`).
   Use `npm run version:release` for version updates; never bump package.json alone.
6. Finish only when every required gate has current evidence, limitations are
   explicit and resources are reconciled. Deliver coherent examples, measured
   results and compatibility notes. A partial phase is progress, not full success.
