/** Operator policy, immutable for a physical host; never workload request data. */
export const GVISOR_RELEASE = "release-20261102.0";
export const GVISOR_ARCHIVE_SHA256 =
  "6f6b1a8f0f4665a403238135167d0d990bfaeaff5544abf68f5e0d822b35484a";
export type RuntimePolicy =
  | { kind: "podman" }
  | {
      kind: "gvisor";
      version: 1;
      release: typeof GVISOR_RELEASE;
      archiveSha256: typeof GVISOR_ARCHIVE_SHA256;
    };
export const PODMAN_RUNTIME: RuntimePolicy = Object.freeze({ kind: "podman" });
export const GVISOR_RUNTIME: RuntimePolicy = Object.freeze({
  kind: "gvisor",
  version: 1,
  release: GVISOR_RELEASE,
  archiveSha256: GVISOR_ARCHIVE_SHA256,
});
export function validateRuntimePolicy(policy: RuntimePolicy): void {
  if (!policy || typeof policy !== "object")
    throw Error("Invalid runtime policy");
  if (policy.kind === "podman" && Object.keys(policy).length === 1) return;
  if (
    policy.kind === "gvisor" &&
    policy.version === 1 &&
    policy.release === GVISOR_RELEASE &&
    policy.archiveSha256 === GVISOR_ARCHIVE_SHA256 &&
    Object.keys(policy).length === 4
  )
    return;
  throw Error("Unsupported or unpinned runtime policy");
}

/** Optional approved-image application init; same unprivileged policy on either runtime. */
export function validateWorkloadInit(
  argv: readonly string[] | undefined,
): void {
  if (argv === undefined) return;
  if (
    !Array.isArray(argv) ||
    argv.length < 1 ||
    argv.length > 256 ||
    !argv[0] ||
    argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
    new TextEncoder().encode(JSON.stringify(argv)).byteLength > 65536
  )
    throw Error("Invalid operator workload init");
}
