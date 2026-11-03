import type { StateStore } from "../core/contracts.js";
import { identifier } from "../core/contracts.js";

/** Operator configuration, never a field in a workload request. */
export type HostBackend = { kind: "python" } | { kind: "rust"; sha256: string };
export const PYTHON_HOST_BACKEND: HostBackend = Object.freeze({
  kind: "python",
});
export function validateHostBackend(backend: HostBackend): void {
  if (
    !backend ||
    (backend.kind !== "python" && backend.kind !== "rust") ||
    (backend.kind === "rust" && !/^[a-f0-9]{64}$/.test(backend.sha256)) ||
    Object.keys(backend).some(
      (key) => key !== "kind" && !(backend.kind === "rust" && key === "sha256"),
    )
  )
    throw Error("Invalid host backend identity");
}
export function sameHostBackend(
  left: HostBackend,
  right: HostBackend,
): boolean {
  validateHostBackend(left);
  validateHostBackend(right);
  return (
    left.kind === right.kind &&
    (left.kind === "python" ||
      (right.kind === "rust" && left.sha256 === right.sha256))
  );
}
/** Binding precedes bootstrap/control effects and survives process restart. */
export async function bindHostBackend(
  state: StateStore,
  host: string,
  backend: HostBackend,
): Promise<void> {
  identifier(host);
  validateHostBackend(backend);
  await state.transaction((tx) => {
    const key = `host-backend/${host}`;
    const prior = tx.get<HostBackend>(key);
    if (prior && !sameHostBackend(prior, backend))
      throw Error("Host backend changed; explicit host replacement required");
    if (!prior && backend.kind === "rust" && tx.get(`boat-bootstrap/${host}`))
      throw Error("Existing bootstrap cannot be converted to Rust");
    if (!prior) tx.put(key, structuredClone(backend));
  });
}
export function hostControlArguments(
  backend: HostBackend = PYTHON_HOST_BACKEND,
): string[] {
  validateHostBackend(backend);
  if (backend.kind === "rust")
    return [
      "env",
      "-i",
      "PATH=/usr/bin:/bin",
      "/opt/jetski/native/jetski-host",
      "__control",
      backend.sha256,
    ];
  // A controller with fresh/lost metadata must not silently invoke Python on a native host.
  return [
    "env",
    "-i",
    "PATH=/usr/bin:/bin",
    "sh",
    "-c",
    "test ! -e /var/lib/jetski-native/intent.json && exec python3 -I /opt/jetski/host/control.py",
  ];
}
export function hostControlCommand(
  backend: HostBackend = PYTHON_HOST_BACKEND,
): string {
  return hostControlArguments(backend)
    .map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)
    .join(" ");
}

export function verifyBackendStatus(
  backend: HostBackend,
  result: unknown,
): void {
  if (backend.kind !== "rust") return;
  if (
    !result ||
    typeof result !== "object" ||
    !("hostBackend" in result) ||
    !result.hostBackend ||
    typeof result.hostBackend !== "object" ||
    !("kind" in result.hostBackend) ||
    result.hostBackend.kind !== "rust" ||
    !("sha256" in result.hostBackend) ||
    result.hostBackend.sha256 !== backend.sha256
  )
    throw Error("Native host readiness identity mismatch");
}
