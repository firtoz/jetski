# Jetski 0.2.0

Portable sandboxes with a released embedded API, optional boxd hosts and durable
memory forks. Install with `npm install --save-exact @firtoz/jetski@0.2.0`.
The CLI remains `jetski`; supported Node.js is 24.22.1 or newer.

- Embedded `runSandbox` / `openJetski` and server-backed session helpers with
  strict TypeScript types, stable operation identities and observed outcomes.
- Boat, adopted SSH Linux and optional SDK-only boxd machine adapters, with shared
  capability discovery, typed diagnostics and explicit runtime fallback policy.
- gVisor portable memory checkpoints, same-owner disk/RAM forks and strict
  `resumeMemory()`; filesystem copies remain the default. Compatible runtime,
  image and CPU/kernel support are required. External services do not roll back.
- One-shot owner-scoped host preparation, bounded parallel startup, adaptive
  lifetime/idle policy and approved pinned-image cache reuse.
- Faster verified object copying, per-object restore progress, optional bounded
  parallel writes and Boat binary reads, acknowledged upload initialization,
  immutable bootstrap assets and checked Linux image durability barriers.
- Authenticated stream lifetime fixes and graceful viewer draining before capture.
- Seven self-contained TypeScript examples pinned to the registry release,
  including an automated Chromium fork with recorded MP4s.

The measured three-host Chromium workflow fell from 17m36s to 5m53s, including
cold preparation. This small sequence used different physical hosts/times and
local checkpoint storage: it is not a universal speedup or new R2 qualification.
See docs/chromium-transfer-performance.md for timings, failures and boundaries.

## Upgrade deliberately

This is a self-hosted, single-controller 0.x release, not a managed compute service.
It changes host bootstrap assets. Existing installed host identities fail closed
on a mismatch; do not overwrite a retained host to force an upgrade. Quiesce and
publish with the old controller, retain metadata/checkpoint backups, retire its
released hosts, then start one controller on fresh compatible hosts. Retained
memory checkpoints still require their recorded runtime/image compatibility.
Do not assume an older release can read newer optional memory-copy metadata.
Follow docs/releases.md and docs/operations.md before upgrading or rolling back.
No automatic client deployment, runtime upgrade or checkpoint-history expiration
is performed by installing the package. Optional boxd users also install the
pinned peer `@boxd-sh/sdk@0.3.0`. Provider credentials stay outside workloads.
