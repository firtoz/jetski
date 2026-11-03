import { checkpointArchive } from "./checkpoint-layout.js";
import type { CheckpointRegistry } from "./checkpoints.js";
import { canonical, type Fence } from "./contracts.js";
import type { HostLease } from "./pool.js";
import type { WorkloadResources } from "./resources.js";
import type { HostTransport } from "./transport.js";

/** Only a retained, generation-fenced root may authorize the cache fast path.
 * Physical replacements have no previous assignment and use ordinary import. */
export async function resumeCachedCheckpoint(
  registry: CheckpointRegistry,
  fence: Fence,
  lease: HostLease,
  image: string,
  resources: WorkloadResources,
  checkpointId: string,
  transport: HostTransport,
): Promise<boolean> {
  if (!transport.resumeCached || lease.generation === 1) return false;
  if (lease.owner !== fence.owner || lease.sandboxId !== fence.sandbox)
    throw Error("Cached resume scope mismatch");
  const reader = crypto.randomUUID();
  await registry.admit(fence, reader, "reader", checkpointId);
  try {
    const root = await registry.root(fence, checkpointId);
    if (
      !root ||
      root.frames.some(
        (frame) =>
          frame.owner !== fence.owner || frame.sandbox !== fence.sandbox,
      )
    )
      throw Error("Cached resume root mismatch");
    const archive = checkpointArchive(root);
    const receipt = await transport.resumeCached(lease.machineId, {
      lease,
      image,
      resources,
      checkpointId,
      sha256: archive.sha256,
      bytes: archive.bytes,
    });
    if (
      !receipt ||
      typeof receipt !== "object" ||
      Array.isArray(receipt) ||
      canonical(receipt.lease ?? null) !== canonical(lease) ||
      receipt.checkpointId !== checkpointId ||
      receipt.sha256 !== archive.sha256 ||
      receipt.bytes !== archive.bytes ||
      typeof receipt.ready !== "boolean"
    )
      throw Error("Invalid cached resume identity");
    if (!receipt.ready) {
      if (receipt.runtime !== null)
        throw Error("Runtime admitted on cache miss");
      return false;
    }
    const runtime = receipt.runtime;
    if (
      !runtime ||
      typeof runtime !== "object" ||
      Array.isArray(runtime) ||
      runtime.phase !== "running" ||
      runtime.image !== image ||
      !runtime.configuration ||
      typeof runtime.configuration !== "object" ||
      Array.isArray(runtime.configuration) ||
      runtime.configuration.image !== image ||
      runtime.configuration.memoryMb !== resources.memoryMb ||
      runtime.configuration.cpus !== resources.cpus
    )
      throw Error("Invalid cached resume runtime");
    // New runtimes attest the complete lease; names remain opaque. Existing
    // immutable Podman hosts use their original deterministic-name contract.
    const exactLease =
      runtime.lease === undefined
        ? runtime.name === "jetski-" + lease.assignmentId
        : canonical(runtime.lease) === canonical(lease);
    if (!exactLease) throw Error("Invalid cached resume runtime identity");
    return true;
  } finally {
    await registry.close(fence, reader);
  }
}
