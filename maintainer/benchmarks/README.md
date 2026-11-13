# Measurements that inform decisions

These reports support implementation choices and scoped claims. They are not
getting-started guides or instructions to rerun paid experiments. Each keeps its
workload, build/profile, sample size, durability boundary and material failures.
Historical prices are experiment accounting, not current quotes.

| Decision                                    | Evidence                                |
| ------------------------------------------- | --------------------------------------- |
| Filesystem transfer and warm cache strategy | [Filesystem checkpoints](filesystem.md) |
| Host lifetime and adaptive idle policy      | [Host lifecycle](host-lifecycle.md)     |
| Provider capability/profile support         | [Boat/boxd](providers.md)               |
| Runtime isolation/compatibility tradeoffs   | [Podman/gVisor](runtime.md)             |
| Memory compression and reuse                | [Portable memory](memory.md)            |
| Public-egress profile support               | [Networking](network.md)                |
| Whether to select the native host           | [Python/Rust](native-host.md)           |
| Whether to combine capture and quiescence   | [Host stages](host-stages.md)           |
| Full-browser fork settings and bottlenecks  | [Chromium fork](chromium.md)            |

Sanitized aggregates live in [data](data/). Routine receipts, credentials, process
handles and account-specific recovery material stay private. Superseded candidate
narratives and completed goal plans are available in version history, rather than
maintained as another archive. See [qualification](../qualification.md) for the
cross-cutting acceptance boundary and consequential failures.
