# Jetski

**Run isolated Linux workloads, keep their files, and reuse the compute.**

Jetski is an MIT-licensed TypeScript sandbox library. It gives your application
commands, files and durable checkpoints while managing the remote machines
underneath. Embed its controller in Node, connect to an independent service, or
integrate its core into your own platform.

## What can you use it for?

- **Build and batch jobs:** run sequential sessions on a warm host instead of
  provisioning a VM for every job.
- **Persistent workspaces:** save files independently of an execution host and
  restore them into the same logical sandbox or a separate writable copy.
- **Interactive tools:** add terminals and authenticated previews through scoped
  gateways. Compatible gVisor workloads can also save and restore process memory.

A logical sandbox owns its workspace, checkpoints and command identities. A
physical host supplies compute. Jetski separates the two: one host can serve
successive sessions for the same owner, and saved files can outlive that host.
There is one active assignment per host and no cross-owner host reuse.

## Try a command

You need Node 24.22.1 or newer, a Boat API token, and a Linux OCI image reference
pinned to its full `@sha256:…` digest. The image must contain the command you run.
Workloads execute remotely; no container runtime is required on your laptop.
Host allocation can incur provider charges.

```sh
npm install --save-exact @firtoz/jetski@0.3.0
```

Set `BOAT_API_TOKEN` privately. For the `echo` trial, the repository examples use
this pinned Alpine image; approve a different digest when your workload needs it:

```sh
export JETSKI_IMAGE=docker.io/library/alpine@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f
```

Save this as `hello.ts`, then run `node hello.ts`:

```ts
import { runSandbox } from "@firtoz/jetski/node";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw Error(`Set ${name}`);
  return value;
}

const result = await runSandbox(
  {
    provider: { kind: "boat", token: env("BOAT_API_TOKEN") },
    image: env("JETSKI_IMAGE"),
    dataDirectory: "./.jetski",
  },
  ["echo", "Hello, world!"],
);
console.log(result.stdout);
```

This one-shot helper runs the command, saves files, releases the assignment and
closes its controller, retiring eligible owned hosts. State and checkpoints live
in `.jetski/` on the machine running this script. Keep that directory private.

[Complete Boat example](examples/02-hello-world-boat/) ·
[Try boxd instead](examples/06-boxd/) ·
[Connect to an existing service](examples/01-hello-world/).
The first example uses the published API; [compatibility](docs/compatibility.md)
identifies additions awaiting release.

## Build on it

| You want to…                                        | Start here                                                                                     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Read/write files and restore a saved workspace      | [Files and checkpoints](examples/04-files-and-checkpoints/)                                    |
| Reuse hosts across several sessions                 | [Warm reuse](examples/05-warm-pool/) with a long-lived `openJetski()` controller               |
| Store checkpoints off the controller disk           | [R2 example](examples/03-hello-world-r2/) and [storage locations](docs/storage-locations.md)   |
| Recover after a disconnect without replaying work   | [Recovery guide](docs/failure-recovery.md) and [reconnect example](examples/08-reconnect/)     |
| Add terminals, previews or TCP forwarding           | [Interactive access](docs/interactive-access.md)                                               |
| Restore compatible process memory or fork a browser | [Portable memory](docs/portable-memory.md) and [advanced demo](examples/07-memory-fork/)       |
| Run a shared controller or embed a platform         | [Standalone service](docs/standalone.md) or [platform integration](docs/embedded-platforms.md) |

Use `/node` for an embedded Node controller, `/sdk` for clients of an independent
service, and `/core` plus adapter exports for advanced integration. Portable
core/HTTP-client imports do not load SQLite, SSH or provider SDKs.
[Shared API and lifecycle](docs/simple-api.md).

## Choose the right boundary

Boat and boxd allocate remote machines; SSH adopts explicitly prepared Linux hosts.
Podman is the default runtime, with opt-in gVisor. Jetski is self-hosted software,
not a managed compute service. You operate one authoritative controller and pay
for compute, retained idle capacity, checkpoint storage and controller hosting.

Writing a file is not a durable checkpoint. `checkpoint()` publishes files and
stops execution; `stop()` also releases the assignment. A released host may stay
warm while its controller runs. Filesystem recovery does not continue process
memory. Timeouts stop observation and do not confirm remote cancellation.

Back up controller metadata as well as checkpoint objects. Failed or uncertain
saves retain their source. Retained history is not silently erased on shutdown.
[Lifecycle table](docs/simple-api.md#lifecycle) · [Operations and backups](docs/operations.md) ·
[Runtime choices](docs/runtime-comparison.md) · [Cost model](docs/costs.md).

[Documentation](docs/README.md) · [Examples](examples/README.md) ·
[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [License](LICENSE).
