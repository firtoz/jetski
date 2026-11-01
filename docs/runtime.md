# Host runtime boundary

The trusted host composition uses `RuntimeBackend` in
`host/runtime_backend.py`. It supplies a `SandboxRuntime` for create, quiesce,
remove and confirmed-absence checks, and an `ExecutionRuntime` for command,
terminal and forwarding sessions. Control dispatch, command workers and the
stream broker use this boundary. The supplied `PodmanBackend` is the only
installed and qualified implementation.

Runtime selection belongs to the operator-owned host bundle. Workload requests
cannot name a Python module, choose a backend or replace host credentials.
An alternate bundle must use the same backend in all entry points, including
workers launched after the controller exits. A per-call test injection is not a
persistent deployment configuration.

## Adapter obligations

- Preserve the versioned lease and lifecycle receipts. A stale lease must be
  rejected before any effect; shared host journals own admission and replay.
- Keep runtime identities scoped to the assignment. Reconnection observes the
  same command/session identity and never redispatches an uncertain start.
- Quiescence must prove that execution and listeners have stopped before capture.
  Removal and absence must be positively confirmed. A timeout is uncertainty.
- Provide bounded binary execution streams and protocol-v1 supervisor/relay
  framing for exit status, terminal control and TCP forwarding. EOF alone is not
  successful command completion.
- Keep image approval, process/resource restrictions, persistent mount policy and
  credential isolation at least as strict as the shipped runtime.
- Leave checkpoint publication verification, retained-root accounting, generation
  fencing and GC decisions in the shared controller and journals.

The bootstrap and capability checks currently validate rootless Podman. Supporting
another backend requires matching bootstrap/capability negotiation and the complete
lifecycle, security, execution and recovery conformance tests; replacing a factory
alone does not establish support. Managed-sandbox providers also require a distinct
adapter contract and must not be assumed to permit host-runtime installation.
