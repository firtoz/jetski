# Boat / boxd feature parity

## Objective and boundaries

Make both machine hosts usable through consistent typed embedded and standalone
APIs, with matching Jetski runtime, network, storage, checkpoint and interactive
features. Preserve modular imports, owner isolation, durable publication, retained
history, fencing, uncertain-operation identity and exact filesystem recovery.
Native provider-only features remain explicit optional capabilities, never a
promise that Boat implements boxd hibernation. No universal speed/zero-loss claims.

User requested November 5, 2026. Implement before hosted qualification; benchmark
only changed paths. Reuse unchanged evidence from the completed November 5 report.
No verification-matrix expansion without a concrete uncovered requirement/failure.
No production/client cutover, npm publication, desktop runtime installation,
subagents, top-ups or use of prior experiment/GC budgets. New publication needs
user authorization. Paid-host allowances increased by the user to $10 per provider with no host-count
limit. Existing credits/wallet only, no top-ups; keep test leases bounded and
finish the finite cases. Private budget.json is authoritative.

## Finite acceptance gates

| Gate                    | Required evidence                                                                                                                                       | State    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Configuration parity    | Strict Node/server Boat+boxd configuration; secrets external, stable account/policy identity; examples/typechecks                                       | Verified |
| Neutral bootstrap       | Shared channel/assets/policy boundary; same runtime/network/storage/init options, no mandatory provider SDK imports                                     | Verified |
| Capabilities            | Typed declared vs observed/qualified support; explicit rejection of unavailable features; SDK/API docs consistent                                       | Verified |
| Idle pricing            | Currency-safe quotes and budgets, bounded boxd pricing source; no silent currency conversion or invented usage bill                                     | Verified |
| Optional native sleep   | Durable idle-only sleep/wake reconciliation, owner/lease checks, R2 publication before sleep, uncertain outcomes retained; unsupported providers reject | Verified |
| Interactive parity      | Actual boxd PTY/input/resize/signals, HTTP/WSS preview, binary TCP and reconnect through shared machinery                                               | Verified |
| Recovery and comparison | Changed runtime/network cases, exact replacement recovery and finite matched stage timings; reuse baseline unchanged paths                              | Verified |
| Closure                 | Build/typecheck/lint/tests/package pass, consolidated limitations, positive owned cleanup and budget reconciliation                                     | Verified |

The original hosted plan allowed four one-hour hosts/provider. After concrete
failures, the user increased funding to $10 each and removed the host-count limit.
No VM for connectivity. Two changed-path arms plus replacement recovery remain
the finite matrix; stop allocating once
finite gates have evidence. All command IDs/allocation intents recorded before
network mutations. Separate private receipts; public docs contain no credentials,
account IDs, application integrations or routine logs.

## Completed outcome

All finite gates are verified. The [consolidated report](../provider-parity-benchmarks.md)
and [measurements](../benchmarks/provider-parity-2026-11-05.json) retain the method,
failures, candidate boundaries, timings, cost limits and cleanup evidence.
Both runtimes/providers pass five exact warm cycles and actual interactive/network
checks. boxd native RAM/disk wake passes. Both gVisor cases preserve filesystem,
process token/counter/checksum/open-file offset and original output on a different
machine after source deletion. The interrupted boxd replacement resumed its
existing operation; its delay is not a clean latency comparison.

Local checks pass: build/typecheck/lint, 378 TypeScript and 238 Python tests,
Python lint/format, strict example and packed consumer. All ten owned VMs are
absent. Temporary key revocation was verified by a fresh authentication rejection;
private credential copies were removed. Metering lag is explicitly documented;
no allocation remains running merely to wait for billing.

The user authorized committing and pushing this source to main on November 5.
Exact-commit CI is the publication gate; hosted measurements remain tied to the
candidate boundaries documented in the report.
No npm/production/client cutover or protected experiment changes are included. Private receipts,
original failures, archives and final continuation remain under
/home/frtn/.local/state/jetski-qa/parity-20261105; no credentials remain there.

Read this absolute scratchpad at every goal continuation and after compaction;
maintain its full objective and evidence. There is no remaining test matrix to run.
