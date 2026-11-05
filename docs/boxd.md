# boxd machine hosts (source preview)

Jetski can use boxd through its optional TypeScript SDK, without installing or
invoking the boxd CLI. This integration is source-only, not included in npm 0.1.1.
See the [self-contained TypeScript example](../examples/06-boxd/) and the
[measured Boat comparison](boxd-boat-benchmarks.md).

## What is qualified

The bounded November 5 comparison exercises the actual Node controller, Python
host agent, rootless Podman, same approved Alpine image and S3-compatible R2 store
on both providers. It checks command output, filesystem content/modes/hardlinks/
symlinks, warm checkpoint resume and recovery after the source machine is deleted.
The preliminary local-store run additionally copies a checkpoint into a different
logical sandbox. Local adapter tests cover acknowledgement loss and owner fencing.

This does not qualify every runtime or deployment target. Native boxd VM-memory
sleep/fork/snapshot features are separate SDK capabilities, not Jetski memory
checkpoints. gVisor, native memory integration, hosted PTY/TCP/preview qualification
and Cloudflare Worker embedding on boxd remain outside this comparison. The
stream adapter is implemented; passing control/file workflows does not establish
full interactive transport qualification.

## Modular composition

- `@firtoz/jetski/providers/boxd`: machine lifecycle, durable allocation identity and owned deletion.
- `@firtoz/jetski/transport/boxd`: bounded command stdin/stdout and authenticated duplex host streams.
- `@firtoz/jetski/providers/machine-bootstrap`: the existing fenced Python host installer on owned Linux machines.
- `@firtoz/jetski/providers/boxd-hosts`: a Node provider factory composing these pieces.

The application supplies the SDK client. Jetski's runtime dependencies do not
include that SDK; source examples/dev tooling install it explicitly. Importing
SDK/core does not load the boxd SDK or these Node adapters. The narrow structural
client interface is checked against SDK 0.3.0. The client, transactional state,
checkpoint store and lifecycle policy remain replaceable.

Provider factories receive the controller's persisted pool identity, transactional
state and approved images after its lock/configuration checks. Factories must not
allocate machines themselves: demand goes through the provider's journal. A
factory's stable ID denotes one organization/endpoint/region namespace; it is not
permission to move an existing state database to a different account.

## Lifecycle and safety

Creates use a persisted operation ID, a deterministic unique name, ownership
labels, `isolated: true`, SSH disabled and an explicit delete-after timer. The
only create dispatch is admitted before its network effect. After lost creation
acknowledgement, lookup observes the original name; uncertainty does not trigger
a replacement allocation. Inspect checks labels before bootstrap, and successful
bootstrap requires code/policy digests and an exact host/pool readiness receipt.
The host gets no controller API key or R2 credentials.

One active workload per owner-exclusive host remains the core placement rule.
Stop publishes to the selected checkpoint store before assignment release.
Retirement checks the recorded allocation and provider identity and requires
provider absence before success. An uncertain outcome keeps its durable journal.
SSH host-adoption semantics are unchanged: this cloud adapter deletes only its
positively owned VMs; the SSH adapter never powers off operator machines.

The test profile used one-hour maximum leases and fixed ten-minute idle retention.
No provider-native sleep policy was used for the pool. Do not independently pause
or hibernate active Jetski hosts: coordination with those provider states and
cost-aware idle pricing are not qualified here. The adapter conservatively keeps
unknown/non-running hosts unavailable rather than silently replacing a source.
A provider deadline can still destroy unpublished changes; acknowledged R2
checkpoints require retained controller metadata for recovery.

The generic bootstrap installs missing packages on the owned Ubuntu/Debian guest,
not your laptop. Provider base images and package availability affect first setup.
Fresh boxd hosts needed safe bootstrap reconciliation retries in this comparison;
all such attempts remain in readiness timings and used the same allocations.

## Authentication

Use an explicit, expiring organization-scoped API key and the default Node SDK
entry with `maxRetries: 0`. Never use a browser token embedded in public examples,
pass credentials in workload arguments, or copy the controller data directory into
a sandbox. Configure SDK/control deadlines long enough for bootstrap; a timeout
means inspect the original operation, not successful cancellation or a retry grant.

The [vendor SDK guide](https://docs.boxd.sh/reference/typescript-sdk) documents
API-key setup. Its web entry lacks interactive duplex execution and is not a
drop-in transport for this implementation. [boxd pricing](https://boxd.sh/pricing)
bills active CPU, resident memory and written disk; it differs from Boat's
fixed-size compute/start accounting. The benchmark report keeps currencies,
usage estimates, included credits and actual charges separate.
