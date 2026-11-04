# Scoped preferred-runtime admission

Implement a gVisor-preferred staging trial with explicit, operator-approved Podman
fallback before workload execution. Keep the runtime choice immutable per host;
unknown probes, bootstrap failures, command failures and uncertain saves never
trigger fallback. Memory-checkpoint requirements must reject Podman. Preserve
checkpoint bytes, pins, fencing and existing admitted controllers. No production
or standalone global default change, snapshots, desktop changes or subagents.

Read this file and the client-side task when resuming. Public content stays generic.
The user approved a separate $3 Boat allowance on November 4, existing wallet only,
no top-up, at most four small one-hour hosts. Prior budgets/collection are untouched.
Private receipts: `/home/frtn/.local/state/jetski-qa/runtime-preference-20261104/`.

## Finite gates

- [x] Separate prerequisite eligibility from fully verified runtime support; bind
  the candidate before bootstrap, publish readiness only after bootstrap succeeds.
- [x] Owned Boat host preflight, trusted workload qualification/exclusion policy,
  persisted runtime/fallback evidence; unknown outcomes fail closed.
- [x] Client scoped preferred profile, observed selection and safe existing policy.
- [x] Focused tests: preferred/explicit fallback, unknown/error refusal, immutable
  candidate/restart and memory requirement rejection; build/typecheck/lint.
- [x] Two bounded live cases: normal preferred gVisor in staging and a controlled
  operator exclusion selecting Podman; exact files/output and durable warm resume.
- [x] Restore temporary admission scopes, retain acknowledged roots, confirm owned
  cleanup, consolidate evidence and publish main milestones. GitHub waits may be
  bypassed under the existing user instruction; report CI separately.

Do not repeat the completed network/memory benchmark matrix. The fallback case is
an operator-controlled exclusion, not evidence that the physical host lacks gVisor.

## Completed evidence

Runtime `a6abe2e`, qualification 37: build/typecheck/lint and 344 tests pass; exact
source CI is green. Both scoped deployed cases passed, choosing gVisor normally
and Podman only for an explicit operator exclusion. Exact files/output, durable
stop and same-host resume match. Real idle alarms retired both hosts; both control
endpoints are deleted and acknowledged checkpoints retained. Original scope
configuration is restored. See [the consolidated qualification](../runtime-selection.md#scoped-hosted-qualification).

Two starts used, no failed allocations; provider compute value $0.00679, bounded
below $0.00745 with retirement tails. Both start quotes were zero and the wallet
was unchanged at cent precision. The separate $3 allowance is respected. A failed
read-only status observation is preserved; only bounded observation retry changed,
without command/allocation replay. No further workload or matrix is needed.

All functional/cleanup gates are closed. Final documentation publication and its
CI are recorded privately; hosted CI waits may be bypassed under the user's
instruction. Existing defaults and admitted controllers remain unchanged.
