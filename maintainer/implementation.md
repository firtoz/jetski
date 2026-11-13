# Implementation acceptance

This is the current maintainer acceptance matrix, not a run log. Keep stable
contracts in [design](design.md), test procedures in [testing](testing.md), and
scoped evidence in [qualification](qualification.md). User instructions belong
in [task guides](../docs/README.md).

| Area                        | Acceptance and current boundary                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Package/API                 | Independent packed installs; public strict NodeNext and Worker/Bundler consumers; core/SDK bundles exclude Node-only dependencies.                                             |
| Lifecycle/recovery          | Durable identities, explicit reconciliation, command output cursors, timeout without automatic cancellation/replay; quarantine and unresolved cleanup remain visible.          |
| Commands/interactive access | Shared facade over existing protocols; terminal input acknowledgements; authenticated scoped previews and explicit forwarding.                                                 |
| Embedded integration        | Neutral factories and provider composition; product policy, transactional state and authoritative durable scheduling remain injected.                                          |
| Hosts/runtimes              | Boat, optional boxd and adopted SSH; Podman default, qualified opt-in gVisor and optional native host within their declared matrices.                                          |
| Filesystem durability       | Exact bytes/modes/links, verified publication before release/cache reuse, generation fencing and source retention on uncertainty.                                              |
| Storage/retention           | Local and qualified remote adapters; metadata/object backup, explicit pins, complete reachability, fail-closed collection and minimum 24-hour grace.                           |
| Process memory              | Explicit compatible gVisor RAM/filesystem recovery and independent copies; no silent filesystem-only substitute for memory continuation.                                       |
| Ownership/cost              | One active assignment per host, no cross-owner reuse, zero warm minimum, bounded leases/idle policy, explicit host-only readiness.                                             |
| Documentation/release       | User task navigation, runnable examples and honest availability; useful internal evidence is curated here. Pending changesets use the existing synchronized release machinery. |

Local verification covers build, typecheck, tests, lint, release/version checks and
fresh installed consumer fixtures. [Qualification](qualification.md) distinguishes
these from native CI and hosted evidence. Do not repeat unchanged hosted matrices
or expand support claims from local mocks. Version 0.3.0 includes the controller/SDK
and composition helpers; see [compatibility](../docs/compatibility.md).
