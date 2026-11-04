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
- [ ] Client scoped preferred profile, observed selection and safe existing policy.
- [x] Focused tests: preferred/explicit fallback, unknown/error refusal, immutable
  candidate/restart and memory requirement rejection; build/typecheck/lint.
- [ ] Two bounded live cases: normal preferred gVisor in staging and a controlled
  operator exclusion selecting Podman; exact files/output and durable warm resume.
- [ ] Restore temporary admission scopes, retain acknowledged roots, confirm owned
  cleanup, consolidate evidence and publish main milestones. GitHub waits may be
  bypassed under the existing user instruction; report CI separately.

Do not repeat the completed network/memory benchmark matrix. The fallback case is
an operator-controlled exclusion, not evidence that the physical host lacks gVisor.

Local build/typecheck/lint and all 344 tests pass. Native host filesystem and
memory modules are unchanged; reuse their completed qualification. Next: pinned
artifact and client integration, then the two finite hosted admission cases.
