import { createHash } from "node:crypto";
import { canonical, type StateStore } from "../core/contracts.js";
import { GVISOR_RUNTIME, PODMAN_RUNTIME } from "../core/runtime-policy.js";
import type { RuntimeEligibility } from "../core/runtime-selection.js";
import { BoatControlChannel } from "../transport/boat-channel.js";
import type { BoatApi } from "./boat.js";

/** Read-only, bounded prerequisite inspection on positively owned execution
 * hosts. No image/workload code is run and no runtime is installed here. */
const PROBE = `import json, pathlib, platform
p=pathlib.Path
print(json.dumps({"version":1,"system":platform.system(),"machine":platform.machine(),"controllers":p("/sys/fs/cgroup/cgroup.controllers").read_text().split(),"maxUserNamespaces":int(p("/proc/sys/user/max_user_namespaces").read_text()),"namespaces":all(p("/proc/self/ns/"+n).exists() for n in ("user","mnt","net","pid"))},sort_keys=True))
`;

export type BoatWorkloadQualification = "qualified" | "excluded";
export class BoatRuntimeEligibility {
  private readonly channel: BoatControlChannel;
  constructor(
    state: StateStore,
    api: BoatApi,
    private readonly workload: BoatWorkloadQualification,
  ) {
    if (!["qualified", "excluded"].includes(workload))
      throw Error("Explicit operator workload qualification required");
    this.channel = new BoatControlChannel(state, api, 30);
  }
  async inspect(host: string): Promise<RuntimeEligibility[]> {
    const text = await this.channel.run(host, Buffer.alloc(0), [
      "python3",
      "-I",
      "-c",
      PROBE,
    ]);
    if (Buffer.byteLength(text) > 8192) throw Error("Runtime preflight bound");
    const value = JSON.parse(text);
    if (
      value.version !== 1 ||
      typeof value.system !== "string" ||
      typeof value.machine !== "string" ||
      !Array.isArray(value.controllers) ||
      value.controllers.some((v: unknown) => typeof v !== "string") ||
      !Number.isSafeInteger(value.maxUserNamespaces) ||
      typeof value.namespaces !== "boolean"
    )
      throw Error("Unknown runtime prerequisite evidence");
    const evidenceId =
      "boat-preflight-" +
      createHash("sha256")
        .update(canonical({ host, workload: this.workload, probe: value }))
        .digest("hex");
    let reason:
      | "host-platform"
      | "namespace-support"
      | "resource-enforcement"
      | null = null;
    if (value.system !== "Linux" || value.machine !== "x86_64")
      reason = "host-platform";
    else if (!value.namespaces || value.maxUserNamespaces <= 0)
      reason = "namespace-support";
    else if (
      !["cpu", "memory", "pids"].every((name) =>
        value.controllers.includes(name),
      )
    )
      reason = "resource-enforcement";
    return [GVISOR_RUNTIME, PODMAN_RUNTIME].map(
      (runtime): RuntimeEligibility => {
        if (reason)
          return { runtime, evidenceId, status: "unsupported", reason };
        if (runtime.kind === "gvisor" && this.workload === "excluded")
          return {
            runtime,
            evidenceId,
            status: "unsupported",
            reason: "workload-compatibility",
          };
        return {
          runtime,
          evidenceId,
          status: "eligible",
          networkModes: ["none", "public-egress"],
          portableMemory: runtime.kind === "gvisor",
        };
      },
    );
  }
}
