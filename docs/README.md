# Use Jetski

Start with [a command](../README.md#try-a-command) or the
[runnable examples](../examples/README.md). Jetski runs workloads on configured
execution hosts; you own the controller and its metadata.

## Pick your next task

| Task                                      | Guide                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Choose embedded Node or a service client  | [Getting started](getting-started.md)                                                                                   |
| Work with commands, files and checkpoints | [Application API and lifecycle](simple-api.md)                                                                          |
| Reconnect to interrupted work             | [Failure recovery](failure-recovery.md)                                                                                 |
| Add a terminal or authenticated preview   | [Interactive access](interactive-access.md)                                                                             |
| Select machines and isolation             | [Boat](boat.md), [boxd](boxd.md), [Podman/gVisor tradeoffs](runtime-comparison.md)                                      |
| Allow outbound internet access            | [Networking policy](networking.md)                                                                                      |
| Save compatible process memory            | [Portable memory](portable-memory.md)                                                                                   |
| Choose checkpoint storage                 | [Where data lives](storage-locations.md), [storage adapters](storage.md), [native R2](storage-r2.md)                    |
| Tune reuse, transfer and cost             | [Performance settings](performance-tuning.md), [cost model](costs.md), [stage diagnostics](stage-timings.md)            |
| Deploy or upgrade a shared controller     | [Standalone service](standalone.md), [operations/backups](operations.md), [upgrades](releases.md)                       |
| Embed Jetski into your own platform       | [Composition and scheduling](embedded-platforms.md), [runtime selection](runtime-selection.md), [OpenAPI](openapi.json) |

[Compatibility](compatibility.md) describes API layers and version differences.
Each guide describes the relevant operating
limits; a supported configuration is not a guarantee for every workload or host.

Working on Jetski itself? [Maintainer documentation](../maintainer/README.md)
contains architecture, qualification methods, measured evidence and release
machinery. Ordinary library users can skip it.
