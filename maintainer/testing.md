# Test and qualify changes

From a source checkout, use the Node version in [`.nvmrc`](../.nvmrc):

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run lint
npm run check:release-version
npm run check:changesets
npm run test:release
node scripts/qualify-package.mjs
```

`qualify-package.mjs` installs a fresh packed artifact with lifecycle scripts
disabled. It loads every export, compiles strict NodeNext/Worker/platform consumers
and beginner examples against public declarations, and checks portable bundles.
Fixtures are in [test/consumers](../test/consumers/). The advanced recording demo
is typechecked in the source tree; that does not run or qualify it.

For Python host changes, also run the pinned CI checks, including:

```sh
uvx --from ruff==0.17.3 ruff format --check host examples/qualify-tty.py
```

Use the actual CI workflow for the affected host/native suites. Native execution
and container qualification run on disposable hosts/runners. Do not install
runtimes on the operator's desktop or use protected workloads/credentials as test
fixtures. Reuse unchanged evidence; broaden testing when a changed contract,
concrete failure or uncovered requirement justifies it.

## Storage and recovery harnesses

| Harness                                                                                                            | Purpose                                                                                           |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| [qualify-storage.ts](../examples/qualify-storage.ts)                                                               | Shared local/S3 adapter consistency checks; remote configuration performs real object operations. |
| [qualify-checkpoint-storage.ts](../examples/qualify-checkpoint-storage.ts)                                         | Checkpoint publication and recovery through the selected store.                                   |
| [qualify-filesystem-storage.ts](../examples/qualify-filesystem-storage.ts)                                         | Independent bytes/modes/link recovery oracle.                                                     |
| [qualify-filesystem-gc.ts](../examples/qualify-filesystem-gc.ts)                                                   | Retention/grace and recovered-byte collection checks.                                             |
| [qualify-api.ts](../examples/qualify-api.ts)                                                                       | Service lifecycle and access qualification.                                                       |
| [runtime-workload.mjs](../examples/runtime-workload.mjs), [network-workload.mjs](../examples/network-workload.mjs) | Controlled application/network measurements with explicit fixture limits.                         |

Read each harness's usage before running it. Use fresh scoped identities and an
explicit fixture address list for cleanup. A failed cleanup fails qualification;
preserve uncertain outcomes for reconciliation. Permanent reservation markers
remain consumed. Never directly delete retained history to clean an experiment.

Remote-store/provider qualification can spend money and needs a separately scoped
allowance. No historical plan or report grants a new one. An injected-clock GC
test is not an elapsed real-grace test; a simulated host is not live runtime/provider
qualification. Preserve matched workload/durability boundaries, failures, sample
counts, versions and limits in [consolidated evidence](qualification.md).
Routine logs and process handles stay in private local QA notes.
