# boxd machine hosts

Jetski can use boxd through its optional TypeScript SDK, without installing or
invoking the boxd CLI. This integration is included in `@firtoz/jetski@0.2.1`.
Built-in Node configuration accepts `provider: { kind: "boxd", token, namespace,
region }`. Standalone configuration accepts `hostProvider` with `kind: "boxd"`,
`tokenEnv`, `namespace` and `region`; see [server-boxd.json](../examples/server-boxd.json).
Install the optional peer `@boxd-sh/sdk@0.3.0` alongside Jetski.

Start with the [self-contained example](../examples/06-boxd/). The
[capability matrix](embedded-platforms.md#capabilities) describes supported profiles;
[scoped provider evidence](../maintainer/benchmarks/providers.md) records actual
runtime, interactive, native-idle and replacement checks. Worker embedding and
provider-native fork/snapshot integration remain outside that evidence. Native
VM sleep is distinct from workload RAM checkpoints.

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

Optional controller-managed sleep uses `hostLifecycle.nativeIdle: { mode: "ram" | "disk", afterMs }`. It applies
only after verified durable publication, workload cleanup and assignment release,
with no queued demand. It freezes an idle host/cache, not an active sandbox's
processes. Portable gVisor memory checkpoints remain a separate feature.

Sleep/wake operations have persisted IDs; pending transitions fence assignment.
Unknown outcomes retain capacity and are observed, never blindly replayed. Resume
requires wake observation and normal host readiness before placement. Boat rejects
native sleep; it does not silently emulate it. Automatic provider timers remain
disabled so the controller is authoritative. The allocation deadline remains in
force while asleep. Independent provider changes can leave capacity unavailable;
unpublished data is never promised to survive a provider deadline.

The generic bootstrap installs missing packages on the owned Ubuntu/Debian guest,
not your laptop. Provider base images and package availability affect first setup.
Fresh boxd hosts needed safe bootstrap reconciliation retries in this comparison;
all such attempts remain in readiness timings and used the same allocations.

## Authentication

Use an explicit organization-scoped API key, preferably with server-enforced
expiry, and the default Node SDK entry with `maxRetries: 0`. If its creation
interface offers no expiry, arrange revocation after the intended use. Never use a browser token embedded in public examples,
pass credentials in workload arguments, or copy the controller data directory into
a sandbox. Configure SDK/control deadlines long enough for bootstrap; a timeout
means inspect the original operation, not successful cancellation or a retry grant.

The [vendor SDK guide](https://docs.boxd.sh/reference/typescript-sdk) documents
API-key setup. Its web entry lacks interactive duplex execution and is not a
drop-in transport for this implementation. [boxd pricing](https://boxd.sh/pricing)
bills active CPU, resident memory and written disk; it differs from Boat's
fixed-size compute/start accounting. The benchmark report keeps currencies,
usage estimates, included credits and actual charges separate.

## Shared policy and discovery

Both built-in providers accept `runtime`, `networkMode`, `networkFilter`, `storageMode` and
`workloadInit`. The default is Python/rootless Podman without network access.
gVisor must be digest/version pinned; `public-egress` uses the same filtered host
networking policy. An ineligible combination is rejected, not downgraded silently.
Existing physical hosts retain their immutable bootstrap identity and require
replacement to change runtime policy. Native idle policy is snapshotted per slot.

`/v1/capabilities` exposes `host.features`: supported adapter configuration
and native idle modes. Its `evidence: "adapter-declaration"` is deliberately not
a readiness or compatibility claim. Per-sandbox runtime capabilities remain an
observation of its actual assigned host. See the scoped evidence for actual supported combinations.

For adaptive idle on boxd, set the idle budget's `currency: "EUR"` (or the actual
account currency), and configure `idlePricing: { diskGiB: NUMBER }` on its host
provider. The disk value is an operator estimate including local cached archives.
A bounded pricing reader uses account rates, full configured CPU/RAM capacity and
that disk estimate; actual idle usage is usually lower. It does not invent a start
fee or turn a quote into infrastructure spending authorization. Quote/budget
currency mismatch falls back to the configured timeout. Omitted older currencies
mean USD; there is no implicit foreign-exchange conversion. Boat quotes are USD.

The SDK's duplex API lacks a drain primitive. boxd host streams therefore use the
shared credit relay: at most four 16 KiB output frames outstanding, input credit
only after the host control pipe accepts bytes, and explicit failure on invalid
credits/frames. Neither direction blindly replays network bytes after reconnect.

## Portable egress enforcement

`networkFilter` accepts `auto` (default), `nft-netdev` or `tc-bpf`. Both enforce
public IPv4 only, the fixed DNS exception, private/metadata/outer-host destination
denial, guest source checks and IPv6 denial in the workload's private namespace.
The auto path first checks nftables without changing rules. A known unsupported
kernel hook selects tc/BPF; ambiguous errors fail closed. A failed installation
never admits a workload or retries a second identity.

The tc backend uses bounded classic BPF, not a privileged BPF syscall or an
unfiltered network fallback. It checks packet lengths before loads and unsigned
arithmetic, installs the filter before workload admission, and reads back the
exact kernel instruction sequence. Additional or changed filters reject reuse.
The placement journal records which backend and fingerprint were verified.

The missing nft netdev hook on a tested boxd kernel is a known case for the verified
tc backend. Its failed admission and subsequent exact policy checks are retained
in [provider evidence](../maintainer/benchmarks/providers.md); no unfiltered fallback
is permitted.

## Terminal compatibility

The command supervisor first uses the kernel's foreground-group signal ioctl.
For sandbox kernels that do not implement it, a compatibility path sends the
terminal's configured signal character through its line discipline. This requires
`ISIG` and an enabled signal character; raw-mode signalling is not supported by
that path. It does not resolve a numeric foreground process group and race its
reuse. As with stdin, acceptance does not promise consumption if a workload
concurrently changes its terminal settings. Missing authenticated completion still
quarantines the session; it is never converted into successful execution.
