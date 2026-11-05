import { canonical, identifier, type StateStore } from "../core/contracts.js";
import type { HostIdlePower, HostPowerRequest } from "../core/host-power.js";
import { type BoxdAllocation, type BoxdClient, boxdNotFound } from "./boxd.js";

type Transition = {
  input: HostPowerRequest;
  action: "sleep" | "wake";
  phase: "dispatched" | "finished";
};
/** No blind retry after an uncertain pause/wake. Observe the same host and
 * operation; unresolved outcomes retain capacity until reconciliation/retirement. */
export class BoxdIdlePower implements HostIdlePower {
  constructor(
    private state: StateStore,
    private client: BoxdClient,
    private poolId: string,
    private owned: (host: string) => Promise<BoxdAllocation>,
  ) {}
  async sleep(input: HostPowerRequest) {
    const result = await this.transition(input, "sleep");
    if (result === "awake") throw Error("Invalid sleep receipt");
    return result;
  }
  async wake(input: HostPowerRequest) {
    const result = await this.transition(input, "wake");
    if (result === "asleep") throw Error("Invalid wake receipt");
    return result;
  }
  private async transition(
    input: HostPowerRequest,
    action: "sleep" | "wake",
  ): Promise<"asleep" | "awake" | "pending" | "absent"> {
    identifier(input.operationId);
    const allocation = await this.owned(input.host);
    if (
      allocation.owner !== input.owner ||
      allocation.operationId !== input.allocationId ||
      allocation.expiresAt !== input.expiresAt ||
      input.expiresAt <= Date.now()
    )
      throw Error("Native power authority mismatch");
    if (allocation.phase === "retired") return "absent";
    if (input.mode !== "ram" && input.mode !== "disk")
      throw Error("Unsupported native idle mode");
    const expected =
      action === "wake"
        ? "running"
        : input.mode === "ram"
          ? "suspended"
          : "hibernated";
    const method =
      action === "sleep"
        ? input.mode === "ram"
          ? this.client.machines.pause
          : this.client.machines.hibernate
        : input.mode === "ram"
          ? this.client.machines.resume
          : this.client.machines.wake;
    if (!method) throw Error("Native idle capability unavailable");
    const key = `boxd/${this.poolId}/power/${input.operationId}`;
    const observed = async () => {
      try {
        const machine = await this.client.machines.get(input.host);
        if (
          machine.id !== allocation.id ||
          machine.name !== allocation.name ||
          machine.labels["jetski-pool"] !== this.poolId ||
          machine.labels["jetski-allocation"] !== allocation.operationId
        )
          throw Error("Native power ownership mismatch");
        return machine.status;
      } catch (error) {
        if (boxdNotFound(error)) return "absent";
        throw error;
      }
    };
    const before = await observed();
    if (before === "absent") return "absent";
    const actionable =
      action === "sleep"
        ? before === "running"
        : before === (input.mode === "ram" ? "suspended" : "hibernated");
    if (before !== expected && !actionable) return "pending";
    const admission = await this.state.transaction((tx) => {
      const prior = tx.get<Transition>(key);
      if (prior) {
        if (
          canonical(prior.input) !== canonical(input) ||
          prior.action !== action
        )
          throw Error("Native power operation identity conflict");
        return false;
      }
      tx.put(key, { input, action, phase: "dispatched" } satisfies Transition);
      return true;
    });
    if (before !== expected && admission) {
      // Only known opposite states are actionable; unknown states stay fenced.
      const valid =
        action === "sleep"
          ? before === "running"
          : before === (input.mode === "ram" ? "suspended" : "hibernated");
      if (valid) await method.call(this.client.machines, input.host);
    }
    const after = await observed();
    if (after === "absent") return "absent";
    if (after !== expected) return "pending";
    await this.state.transaction((tx) => {
      const prior = tx.get<Transition>(key);
      if (
        !prior ||
        canonical(prior.input) !== canonical(input) ||
        prior.action !== action
      )
        throw Error("Native power receipt fenced");
      tx.put(key, { ...prior, phase: "finished" });
    });
    return action === "sleep" ? "asleep" : "awake";
  }
}
