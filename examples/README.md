# Examples

Choose a small example for the value you want to try. Each numbered folder has its
own package manifest, setup instructions and TypeScript entry point. The published
examples install `@firtoz/jetski@0.3.0` from npm without a Jetski source build or
sibling link. Run `npm run typecheck` to check types; Node execution alone does not.
Provider examples can allocate billable resources and require your own credentials.

| Try this                                                | What you get                                                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [01 — Service client](01-hello-world/)                  | Run a command through an existing Jetski service.                                                   |
| [02 — Embedded Boat](02-hello-world-boat/)              | Run one command without a separate service.                                                         |
| [03 — R2 storage](03-hello-world-r2/)                   | The same Boat workload with remote checkpoint objects.                                              |
| [04 — Files and checkpoints](04-files-and-checkpoints/) | Save files and verify a distinct restored sandbox.                                                  |
| [05 — Warm reuse](05-warm-pool/)                        | Sequential sessions on one long-lived controller.                                                   |
| [06 — Embedded boxd](06-boxd/)                          | The same one-shot API with boxd provider configuration.                                             |
| [08 — Reconnect](08-reconnect/)                         | Persist identities and observe interrupted work without replay; requires the pending API additions. |

Boat and boxd examples differ primarily in their provider block. Local and R2
examples differ primarily in storage configuration. Keep controller directories
and owner/provider namespaces separate; changing credentials does not authorize
adopting another account's machines or objects.

## Advanced demonstrations

[07 — Browser memory fork](07-memory-fork/) restores one compatible gVisor RAM/disk
checkpoint into two independently writable browser sandboxes. Its setup, recording
requirements and limitations make it an advanced example, rather than a first run.

The [runtime workload](runtime-workload.mjs), [network workload](network-workload.mjs)
and [isolated browser desktop](browser-desktop.mjs) are focused workload probes.
Read their usage and isolation requirements before running them; a private browser
demo does not authorize access to your real desktop or qualify untrusted browsing.

For the shared contracts, read [API/lifecycle](../docs/simple-api.md),
[recovery](../docs/failure-recovery.md) and [interactive access](../docs/interactive-access.md).
Qualification scripts and configuration-fixture details belong to
[maintainer testing](../maintainer/testing.md).
