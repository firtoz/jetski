/** Workload limits, independent of the provider's physical machine size. */
export type WorkloadResources = { cpus: number; memoryMb: number };

export const DEFAULT_WORKLOAD_RESOURCES: Readonly<WorkloadResources> =
  Object.freeze({ cpus: 1, memoryMb: 512 });

export function workloadResources(value: unknown): WorkloadResources {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid workload resources");
  const resources = value as Record<string, unknown>;
  if (
    Object.keys(resources).some(
      (key) => key !== "cpus" && key !== "memoryMb",
    ) ||
    typeof resources.cpus !== "number" ||
    !Number.isInteger(resources.cpus) ||
    resources.cpus < 1 ||
    resources.cpus > 64 ||
    typeof resources.memoryMb !== "number" ||
    !Number.isInteger(resources.memoryMb) ||
    resources.memoryMb < 128 ||
    resources.memoryMb > 65536
  )
    throw Error("Invalid workload resources");
  return { cpus: resources.cpus, memoryMb: resources.memoryMb };
}
