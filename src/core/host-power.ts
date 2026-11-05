/** Optional native host transitions. Only the pool coordinator may call these,
 * after durable sandbox publication, workload cleanup and assignment release. */
export const HOST_IDLE_MODES = ["ram", "disk"] as const;
export type HostIdleMode = (typeof HOST_IDLE_MODES)[number];
export type HostPowerRequest = {
  host: string;
  allocationId: string;
  operationId: string;
  owner: string;
  expiresAt: number;
  mode: HostIdleMode;
};
export interface HostIdlePower {
  sleep(input: HostPowerRequest): Promise<"asleep" | "pending" | "absent">;
  wake(input: HostPowerRequest): Promise<"awake" | "pending" | "absent">;
}
