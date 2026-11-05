# Outbound networking

Networking is trusted operator policy. Workload requests cannot enable it, select
host networking or change the namespace/filter configuration.

| Profile         | Runtime                           | Contract                                                                                                   |
| --------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `none`          | Podman, gVisor                    | Default; no outbound internet                                                                              |
| `egress`        | Podman                            | Legacy slirp path; host-loopback mapping disabled, private networks are not generally blocked              |
| `public-egress` | Python host with Podman or gVisor | Experimental IPv4 internet with a shared, fail-closed destination filter; hosted qualification in progress |

Select the profile when composing a host bootstrap. It is fixed for that host;
changing policy requires a replacement, not a change to a running assignment.

```ts
const bootstrap = new BoatBootstrap(
  state,
  api,
  poolId,
  approvedImages,
  "public-egress",
  "default",
  GVISOR_RUNTIME, // PODMAN_RUNTIME uses the same public-egress policy.
);
```

Import `BoatBootstrap` from `@firtoz/jetski/providers/boat-bootstrap` and runtime constants
from `@firtoz/jetski/core`. Admission adapters must explicitly prove support for the
requested profile; binary presence alone is insufficient. The Rust host does not
implement `public-egress`. Existing host policies and deployment defaults stay
unchanged.

## Isolation and lifecycle

A trusted namespace adapter owns a small, from-scratch keeper with no workload
image, persistent workload mounts or provider credentials. Pasta supplies IPv4
translation; nftables filters packets at the namespace interface. Both workload
runtimes use that same path. gVisor runs the workload in its application kernel;
using Podman to own the network helper does not run the workload outside gVisor.

For the Podman public profile, the workload and trusted keeper share the engine
account's private rootless user namespace. They do not enter the outer host user
namespace. Admission checks the actual namespace identities and mapped non-root
workload owner after launch; this avoids a nested-namespace sysctl conflict.
Workload PID and mount namespaces remain isolated, all capabilities are dropped,
and one active assignment per host with no cross-owner reuse remains mandatory.

The profile denies known private, loopback, link-local, multicast, reserved,
metadata and placement-local host IPv4 destinations. Only the designated virtual
resolver's TCP/UDP DNS port is excepted. DNS answers do not grant access to private
addresses. IPv6 is refused in this initial profile. This is a public-destination
policy, not a domain allowlist, rate limiter or promise that arbitrary internet
content is safe.

Admission verifies the namespace owner, PID/start time, user/network namespace
identities, subordinate mappings, effective kernel filter and read-only resolver.
Unknown preparation, changed identity or changed filter fails closed. The control
helper is removed after the workload's absence is proved. Generation fencing and
one active assignment per host continue to apply.

## Checkpoints and reconnects

Filesystem checkpoints retain their existing durable publication rules. A network
namespace and its provider connections are placement-specific; they are not
portable storage objects. Portable gVisor memory policy binds the semantic network
profile and normalizes only independently verified placement paths.

External sockets must disconnect and applications must reconnect. This profile
disables live TCP migration and connected-socket save. Neither a memory checkpoint
nor an HTTP retry makes an external side effect exactly once: use application
operation IDs or remote idempotency mechanisms. An uncertain command is observed
under its original identity rather than replayed on another runtime.

[The controlled HTTPS example](../examples/network-workload.mjs) measures DNS,
request latency and bounded transfers against operator-owned fixtures. It verifies
bytes before publishing a downloaded file, refuses to replace an existing target,
and avoids logging capability URLs.
It is a workload component, not a public network benchmark service.
