import { identifier } from "../core/contracts.js";
import {
  type MachineRuntimeOptions,
  machineRuntimeOptions,
} from "./machine-options.js";
export type BoxdHostConfig = MachineRuntimeOptions & {
  kind: "boxd";
  tokenEnv: string;
  namespace: string;
  region: string;
  baseURL?: string;
  vcpu?: number;
  memory?: string;
  idlePricing?: { diskGiB: number };
};

/** Shared early validation for Node and standalone paths, without loading the SDK. */
export function validateBoxdHostConfig(p: BoxdHostConfig): void {
  const exact = (value: object, allowed: string[]) => {
    if (Object.keys(value).some((key) => !allowed.includes(key)))
      throw Error("Unknown boxd configuration field");
  };
  exact(p, [
    "kind",
    "tokenEnv",
    "namespace",
    "region",
    "baseURL",
    "vcpu",
    "memory",
    "idlePricing",
    "networkMode",
    "networkFilter",
    "storageMode",
    "runtime",
    "workloadInit",
  ]);
  if (
    typeof p.tokenEnv !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,127}$/.test(p.tokenEnv)
  )
    throw Error("Invalid provider credential variable");
  identifier(p.namespace);
  if (typeof p.region !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(p.region))
    throw Error("Invalid boxd region");
  const cpu = p.vcpu ?? 2;
  if (
    ![1, 2, 4, 8].includes(cpu) ||
    (p.memory !== undefined && p.memory !== `${cpu * 4}G`)
  )
    throw Error("Invalid boxd machine size");
  if (p.baseURL !== undefined) {
    const url = new URL(p.baseURL);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      p.baseURL.endsWith("/")
    )
      throw Error("Invalid boxd endpoint");
  }
  if (p.idlePricing !== undefined) {
    if (!p.idlePricing || typeof p.idlePricing !== "object")
      throw Error("Invalid boxd pricing policy");
    exact(p.idlePricing, ["diskGiB"]);
    if (
      !Number.isFinite(p.idlePricing.diskGiB) ||
      p.idlePricing.diskGiB <= 0 ||
      p.idlePricing.diskGiB > 65536
    )
      throw Error("Invalid boxd idle disk estimate");
  }
  machineRuntimeOptions(p);
}
