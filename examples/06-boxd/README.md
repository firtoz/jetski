# Hello world directly on boxd

The same one-shot API as [hello world on Boat](../02-hello-world-boat/).
Only the `provider` block differs; command execution, storage and cleanup are identical.
No standalone server, custom JSON config or boxd CLI is required by Jetski.
Uses the released `@firtoz/jetski@0.3.0` package.
Requires Node 24.22.1+ and an existing boxd account/API key. Hosts can incur charges.

From this folder (no root install or Jetski build required):

```sh
npm install
export BOXD_API_KEY=your-existing-organization-scoped-key
export JETSKI_IMAGE=your-approved-image@sha256:YOUR_DIGEST
npm run typecheck
npm start
```

The image must contain `echo` and satisfy the runtime's image contract. Set
`region` to your chosen boxd region and `namespace` to a stable identity for that
organization/endpoint/region. Use a different data directory for another provider
or account; an existing controller's identity cannot silently change. The optional
`@boxd-sh/sdk` dependency is installed by this folder's package manifest.

`dataDirectory` and `storage: { kind: "local" }` mean this script's machine:
SQLite metadata is in `./.jetski/state.sqlite` and checkpoint objects in
`./.jetski/objects`, relative to the process working directory. They are independent
of boxd's disposable disk/cache. For remote objects, use the same
[R2 storage configuration](../03-hello-world-r2/) as Boat; metadata still needs backup.

`runSandbox()` captures output, durably saves, releases the workload and retires
owned hosts before returning. An uncertain save/cleanup rejects and preserves
recovery state; do not blindly rerun. For multiple sessions and warm reuse, use
`openJetski()` as in the [warm-pool example](../05-warm-pool/), with this provider block.
Credentials stay on the controller, outside workloads. Bootstrap runs on allocated
hosts, not your laptop. See [failure recovery](../../docs/failure-recovery.md) and
[boxd capabilities and limits](../../docs/boxd.md).
