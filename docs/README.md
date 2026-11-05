# Jetski documentation

Jetski runs isolated workloads on reusable hosts and saves declared persistent
files independently of those hosts. You operate the controller; Jetski is not a
hosted compute service. Start with a small example, then choose your storage and
runtime deliberately.

## Start here

- [Getting started](getting-started.md): choose embedded usage or a standalone server.
- [Runnable examples](../examples/README.md): hello world, Boat, R2, files and warm reuse.
- [Where data lives](storage-locations.md): controller disk, execution host, cache and R2.
- [Simple API](simple-api.md): shared methods, lifecycle and error handling.
  The new convenience helpers are a local unpublished draft, not in npm 0.1.1.

## Build an application

- [Architecture and contracts](design.md): replaceable boundaries and core guarantees.
- [Boat hosts](boat.md): provisioning and bootstrap; SSH adoption is in the standalone guide.
- [Checkpoint storage](storage.md) and [native R2 bindings](storage-r2.md): adapter contracts.
- [Runtime selection](runtime-selection.md): Podman, optional gVisor and fallback policy.
- [Networking](networking.md): egress and isolation boundaries.
- [Portable memory](portable-memory.md): process recovery, compatibility and limits.
- [OpenAPI](openapi.json): explicit versioned HTTP operations.

## Run a controller

- [Standalone guide](standalone.md): configuration, API, CLI, terminals and gateways.
- [Operations](operations.md): supported deployment scope, backups, alerts and disaster recovery.
- [Releases](releases.md): installation and release artifacts.

## Understand the measurements

- [Costs](costs.md): compute, starts, retained idle time and modeling assumptions.
- [Benchmarks](benchmarks.md): measured results and comparison boundaries.
- [Runtime comparison](runtime-comparison.md): isolation, compatibility and measured tradeoffs.
- [Qualification](qualification.md): evidence and known limitations.

Implementation plans and experiment notes are maintainer material. User-facing
instructions above describe how to use the project; measurements distinguish
local fixtures from live provider qualification.
