# Jetski on boxd, through the SDK

Source preview: this adapter is not in npm 0.1.1. It uses the optional
`@boxd-sh/sdk` internally: no CLI, shell integrations, agent skills or daemon.
An existing boxd account/API key is required. New accounts may encounter the
vendor's CLI-onboarding gate before its console exposes API keys; Jetski does not
perform that onboarding or install the CLI for you.

Run `npm install` once in the repository root (it builds the source), then from
this self-contained example folder:

```sh
npm install
export BOXD_API_KEY=your-existing-organization-scoped-key
export JETSKI_IMAGE=your-approved-image@sha256:YOUR_DIGEST
npm run typecheck
npm start
```

Requires Node 24.22.1+. Machines can incur charges. The example provisions owned,
isolated boxd VMs, installs the same rootless Podman host runtime used by Jetski,
runs `echo`, durably saves and releases its workload, then deletes released owned
VMs on `close()`. An uncertain save does not authorize forced deletion.

`dataDirectory` and local checkpoint objects live on this script machine, **not
boxd**. Use the same S3/R2 storage options as the other embedded examples for
remote checkpoints; metadata still needs its own backup.

`boxd-personal-fra` is a stable adapter identity for one organization, endpoint
and region. Choose a different identity/data directory for another namespace.
The built-in client uses `maxRetries: 0`; the adapter journals creates and observes
uncertain outcomes by their original names instead of blindly replaying them.
Credentials stay on the controller, outside workloads. Advanced compositions can still supply a client through `boxdHostFactory`.
The factory obtains persisted pool identity and state from `openJetski`.

The default bootstrap selects Python/rootless Podman. Shared `runtime`,
`networkMode`, `storageMode` and `workloadInit` options are also available; see
the [parity work](../../docs/goals/boat-boxd-parity.md) for qualification status.
Provider SSH and automatic suspend remain disabled; coordinated native idle
sleep is an explicit controller lifecycle policy. This is the Node gRPC SDK path;
the SDK's web entry lacks the duplex stream this adapter needs. Native boxd
memory/forking, gVisor on boxd and Worker embedding are not qualified by this
example. See [support and measurements](../../docs/boxd.md).
