# Embedded platform contracts

Use `/node` for a Node controller and `/sdk` for a service client. A platform
embedding `/core` does not need an HTTP service. The additive composition exports
below are unreleased until the next normal package release.

## Reusable composition

`HostFactory`, `HostFactoryContext` and `HostAdapters` are portable core types.
The existing `NodeHostFactoryContext`/`NodeHostAdapters` names remain aliases.
`boxdHostFactory` returns the same factory contract without referring to Node
controller types. `boatHostFactory` composes API, embedded bootstrap, control
transport, optional injected streams and idle pricing:

```ts
import {
  SandboxManager,
  type CheckpointStore,
  type HostProvider,
  type ManagerOptions,
  type StateStore,
} from "@firtoz/jetski/core";
import { BoatApi } from "@firtoz/jetski/providers/boat";
import { boatHostFactory } from "@firtoz/jetski/providers/boat-hosts";
import { loadBoatBootstrapAssets } from "@firtoz/jetski/host-assets";

export function compose(
  state: StateStore,
  objects: CheckpointStore,
  token: string,
  poolId: string,
  approvedImages: string[],
  wrap: (provider: HostProvider) => HostProvider,
  policy: Omit<ManagerOptions, "poolId" | "approvedImages">,
) {
  const factory = boatHostFactory(new BoatApi(token), {
    id: "owned-machine-namespace",
    loadAssets: loadBoatBootstrapAssets,
    runtimeSelection: {
      preference: { mode: "gvisor-required" },
      workload: "qualified",
      portableMemory: false,
    },
  });
  const hosts = factory.create({ state, poolId, approvedImages });
  const manager = new SandboxManager(
    state,
    wrap(hosts.provider),
    hosts.transport,
    objects,
    {
      ...policy,
      poolId,
      approvedImages,
      ...(hosts.streamTransport
        ? { streamTransport: hosts.streamTransport }
        : {}),
      ...(hosts.idlePriceSource
        ? { idlePriceSource: hosts.idlePriceSource }
        : {}),
    },
  );
  return { manager, hosts };
}
```

The operator must actually qualify the workload before setting `workload:
"qualified"`. Fixed `runtime` defaults to Podman. Alternatively use
`runtimeSelection` for required/preferred selection; supplying both is rejected.
Preferred mode requires an explicit allowlist of reasons. Unknown eligibility,
bootstrap/authentication/integrity/network errors never trigger downgrade. The
factory delegates to the existing two-stage candidate/verified-selection journal.
`hosts.runtimeDecision(host)` returns a verified selection and authorized fallback
reason, or null before verified selection/when using fixed policy. For the assigned
sandbox use `sandbox.runtimeCapabilities()` to inspect actual runtime support.

Existing `archiveReads`, `archiveWrites` and bounded `checkpointUploadConcurrency`
options delegate to the existing Boat transport and enter configuration binding;
this factory does not introduce a new transfer protocol.

The same factory can be passed as `openJetski({ provider: factory, ... })`.
Persist its stable ID, pool and non-secret `configuration` along with the platform's
immutable namespace binding. Changing custom assets, injected stream policy or
wrappers requires the platform's own explicit configuration binding; no factory
can infer the identity of a function. Do not put secrets in `configuration`.

Boat's optional composition uses Node crypto/path/Buffer APIs. Workers must enable
Node compatibility. `/core`, `/sdk` and the fetch preview gateway remain portable without it.
The optional native R2 adapter also requires its documented Node hashing support. Assets are injected from the packed `/host-assets`
export; source checkout users build first. Streams are absent unless injected:
use `BoatStreamTransport` only on a platform supporting its SSH dependencies, or
inject a qualified `HostStreamTransport`. No hidden SSH client is imported by
`boatHostFactory`. Idle pricing is optional via `maxIdleSpendMicros`; it is a
policy estimate, not an account-level spending ceiling.

Use this composition to replace repeated API/bootstrap/control/pricing setup. Keep state and
object storage injection, scheduling, owner identity, admission grants, account
budgets, resource policy, observability, gateway authentication, routing and
product state with the application. Provider wrappers remain outside the factory
so authorization is checked at the real allocation boundary. Do not move product
identities, business state or workload-specific startup into the library.

## Transactional access policy

An access controller can wrap `StateStore.transaction` and use `manager.getIn(tx,
scope)` to check a current reservation alongside owner, running phase, generation
and exact lease. A prior external database read is not atomic admission. Core
fences still apply. Use an unguarded authoritative controller for reconciliation
and cleanup so revocation cannot prevent durable stop/release; retain the product
reservation outside Jetski's generic composition.

## Scheduler contract

A platform must provide these guarantees; this factory does not install a timer:

1. Admission and durable wakeup registration share the authoritative state
   transaction (or an equivalently proven atomic mechanism). Return success only
   when pending work will be reconciled even if the request process disappears.
2. On restart, rediscover pending lifecycle operations and preparations, command
   identities and maintenance deadlines. Reconcile existing work before admitting
   replacements. Work admitted before external dispatch may remain uncertain.
3. Capture a transaction revision **before** computing a maintenance alarm. Apply
   the computed alarm/delete only in a transaction that verifies the revision is
   unchanged. Every concurrent admission advances the revision and preserves an
   earlier durable wakeup. A stale alarm calculation must never erase one.
4. Run `manager.reconcile(owner)` and `manager.maintain(owner)` independently of
   client connections. Include pending work in the next wakeup; a lease deadline
   alone is insufficient. Keep a durable fallback wakeup if a pass fails.
5. Exactly one authoritative controller schedules a state namespace. A local
   directory lock is not cross-machine coordination. Gate ownership handover and
   verify the prior scheduler has stopped before another controller takes over.

For example, a Durable Object state adapter can commit a monotonically increasing
revision and `setAlarm(min(existing, soon))` in every mutating transaction. A later
alarm pass updates/deletes its alarm only if that revision still matches. Keep
all operations inside the platform's actual transaction/serialization semantics;
an in-memory revision is insufficient across restart. Chunking state values and
integrity validation remain the adapter's responsibility.

Node's default interval stops with its process. Remote checkpoint objects do not
make Node scheduling durable. For an independently scheduled deployment use a
supervised service with persisted metadata or a qualified platform adapter. No
new Cloudflare storage adapter or hosted scheduler is qualified by this change.

## Dedicated machine lifecycle

`BoatMachineProvider(state, api, machine?)` exposes allocation, owned physical
inspection and retirement with the existing durable provider journal. It has no
workload transport and no `HostProvider.capabilities()`. It must not be passed to
`SandboxManager` or treated as sandbox readiness. Dedicated-VM integrations can
remove throwing placeholder sandbox transports while retaining their own host
bootstrap, readiness, workload control and artifact verification.

`BoatHostProvider` keeps its existing constructor and adds runtime bootstrap and
attestation to that shared machine lifecycle. Its `inspect()` still reports
unknown until the sandbox host-control agent positively attests readiness.
Neither provider permits foreign adoption or unowned retirement.

## Capabilities

These are adapter contracts and existing qualification boundaries, not new hosted
qualification. Consult the linked reports for exact profiles and limits.

| Capability               | Boat                                                                         | boxd                                                          | Adopted SSH                                                     |
| ------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| Allocation/adoption      | Journaled provider allocation                                                | Journaled labeled allocation in explicit org/region namespace | Explicit configured host list only                              |
| Retirement               | Owned deletion with observed acknowledgement                                 | Owned deletion with observed acknowledgement                  | Releases adoption; never powers off host                        |
| Runtime                  | Podman default; opt-in gVisor                                                | Podman default; opt-in gVisor                                 | Operator-prepared supported host agent/profile                  |
| Network/storage profiles | `none`, `egress`, `public-egress`; default/fuse-overlayfs                    | Same declared profile set                                     | Prepared profile must attest requested requirements             |
| gVisor network           | `none` / qualified `public-egress`; `egress` rejected                        | Same restriction                                              | Requires separately prepared/qualified profile                  |
| Streams, terminals       | Existing PTY/control protocol; live streams need configured stream transport | PTY/control and SDK streams                                   | PTY/control and authenticated SSH streams                       |
| Preview/forwarding       | Scoped port + authenticated configured gateway                               | Same contract                                                 | Same contract; gateway required                                 |
| Leases                   | Controller bounds plus accepted provider expiry                              | Controller bounds plus accepted provider expiry               | Controller assignment lease; operator controls machine lifetime |
| Native sleep/wake        | Not declared                                                                 | Optional suspend/hibernate policies                           | Not declared                                                    |
| Filesystem restore       | Exact verified checkpoint files                                              | Exact verified checkpoint files                               | Requires compatible agent/runtime/image                         |
| Process memory           | Explicit compatible gVisor RAM/disk path                                     | Explicit compatible gVisor RAM/disk path                      | Requires separate compatible-host qualification                 |

Provider resource shapes, minimums, prices and expiry behavior differ. Boat
machine types and boxd region/vCPU/memory options stay discriminated. Unknown or
unsupported requirements fail explicitly; declarations are not evidence of every
provider/profile combination. [Provider parity](../maintainer/benchmarks/providers.md),
[runtime selection](runtime-selection.md), [memory limits](portable-memory.md),
[adapter conformance](../maintainer/qualification.md) and [host lifecycle](../maintainer/benchmarks/host-lifecycle.md).
