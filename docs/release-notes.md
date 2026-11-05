Jetski 0.1.1 fixes the first-release onboarding walkthrough: installed CLI users
can create, execute, inspect command status/output, save and restore without a
source checkout or TypeScript tooling. It adds thin command-status/command-output
CLI mappings to the existing SDK/API and makes artifact checks version-independent.

Host runtimes, checkpoint formats, storage adapters and embedded lifecycle code are
unchanged from0.1.0. Existing qualified evidence remains applicable; the focused
CLI checks and standard source/release CI cover this patch. See docs/operations.md
for the single-controller deployment boundary, backup/recovery and resource limits.
