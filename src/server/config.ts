import { identifier } from "../core/contracts.js";
import { hostLifecycle } from "../core/host-lifecycle.js";
import { workloadResources } from "../core/resources.js";
import {
  PODMAN_RUNTIME,
  validateRuntimePolicy,
  validateWorkloadInit,
} from "../core/runtime-policy.js";
import { validateBoxdHostConfig } from "../providers/boxd-config.js";
import { machineRuntimeOptions } from "../providers/machine-options.js";

export type ServerConfig = {
  dataDirectory: string;
  poolId: string;
  approvedImages: string[];
  workloadResources?: import("../core/resources.js").WorkloadResources;
  automaticCollection?: boolean;
  port?: number;
  host?: string;
  maxSandboxesPerOwner?: number;
  hostsPerOwner?: number;
  hostLifecycle?: import("../core/host-lifecycle.js").HostLifecycle;
  checkpointPackBytes?: number;
  checkpointFrameBytes?: number;
  commandStartWaitMs?: number;
  inlineCommandOutputBytes?: number;
  sshGateway?: {
    hostKeyPath: string;
    host?: string;
    port: number;
    maxConnections?: number;
    principals: Array<{ owner: string; publicKey: string }>;
  };
  preview?: {
    host?: string;
    port: number;
    routes: import("../server/preview.js").PreviewRoute[];
    controlOrigins: string[];
  };
  storage?: import("../server/storage.js").StorageConfig;
  hostProvider: import("../server/hosts.js").HostConfig;
  principals: Array<{ owner: string; tokenEnv: string }>;
};

/** Reject misspelled policy keys before opening state or contacting a provider. */
export function serverConfig(value: unknown): ServerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Configuration object required");
  const c = value as ServerConfig;
  const keys = [
    "dataDirectory",
    "poolId",
    "approvedImages",
    "workloadResources",
    "automaticCollection",
    "port",
    "host",
    "hostsPerOwner",
    "maxSandboxesPerOwner",
    "hostLifecycle",
    "checkpointPackBytes",
    "checkpointFrameBytes",
    "commandStartWaitMs",
    "inlineCommandOutputBytes",
    "sshGateway",
    "preview",
    "storage",
    "hostProvider",
    "principals",
  ];
  if (Object.keys(c).some((k) => !keys.includes(k)))
    throw Error("Unknown configuration field");
  if (typeof c.dataDirectory !== "string" || !c.dataDirectory.trim())
    throw Error("Data directory required");
  if (typeof c.poolId !== "string") throw Error("Pool identity required");
  identifier(c.poolId);
  if (
    !Array.isArray(c.approvedImages) ||
    !c.approvedImages.length ||
    c.approvedImages.some(
      (i) =>
        typeof i !== "string" ||
        !/^[-a-zA-Z0-9./_:]+@sha256:[a-f0-9]{64}$/.test(i),
    )
  )
    throw Error("Digest-pinned image allowlist required");
  if (!Array.isArray(c.principals) || !c.principals.length)
    throw Error("Principals required");
  for (const p of c.principals) {
    if (!p || typeof p.owner !== "string" || typeof p.tokenEnv !== "string")
      throw Error("Invalid principal");
    identifier(p.owner);
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(p.tokenEnv))
      throw Error("Invalid token environment variable");
    if (Object.keys(p).some((k) => !["owner", "tokenEnv"].includes(k)))
      throw Error("Unknown principal field");
  }
  if (!c.hostProvider || !["boat", "boxd", "ssh"].includes(c.hostProvider.kind))
    throw Error("Host provider required");
  const exact = (v: object, allowed: string[]) => {
    if (Object.keys(v).some((k) => !allowed.includes(k)))
      throw Error("Unknown adapter configuration field");
  };
  if (c.hostProvider.kind === "boat") {
    exact(c.hostProvider, [
      "kind",
      "tokenEnv",
      "machine",
      "networkMode",
      "networkFilter",
      "storageMode",
      "runtime",
      "workloadInit",
    ]);
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(c.hostProvider.tokenEnv))
      throw Error("Invalid provider credential variable");
    if (
      c.hostProvider.machine !== undefined &&
      !["small", "default", "large"].includes(c.hostProvider.machine)
    )
      throw Error("Invalid machine size");
    if (
      c.hostProvider.networkMode !== undefined &&
      !["none", "egress", "public-egress"].includes(c.hostProvider.networkMode)
    )
      throw Error("Invalid network mode");
    if (
      c.hostProvider.storageMode !== undefined &&
      !["default", "fuse-overlayfs"].includes(c.hostProvider.storageMode)
    )
      throw Error("Invalid storage mode");
    validateRuntimePolicy(c.hostProvider.runtime ?? PODMAN_RUNTIME);
    validateWorkloadInit(c.hostProvider.workloadInit);
    machineRuntimeOptions(c.hostProvider);
  } else if (c.hostProvider.kind === "boxd") {
    validateBoxdHostConfig(c.hostProvider);
  } else {
    exact(c.hostProvider, ["kind", "hosts"]);
    if (!Array.isArray(c.hostProvider.hosts) || !c.hostProvider.hosts.length)
      throw Error("SSH inventory required");
    for (const host of c.hostProvider.hosts) {
      identifier(host.id);
      for (const field of [
        host.hostname,
        host.user,
        host.privateKeyPath,
        host.knownHostsPath,
      ])
        if (typeof field !== "string" || !field)
          throw Error("Invalid SSH inventory");
      if (
        !Number.isSafeInteger(host.port) ||
        host.port < 1 ||
        host.port > 65535
      )
        throw Error("Invalid SSH port");
    }
    if (
      new Set(c.hostProvider.hosts.map((h) => h.id)).size !==
      c.hostProvider.hosts.length
    )
      throw Error("Duplicate SSH host");
  }
  if (c.storage) {
    if (c.storage.kind === "local") exact(c.storage, ["kind"]);
    else if (c.storage.kind === "s3") {
      exact(c.storage, [
        "kind",
        "bucket",
        "prefix",
        "endpoint",
        "region",
        "accessKeyEnv",
        "secretKeyEnv",
        "sessionTokenEnv",
        "listPageSize",
      ]);
      const endpoint = new URL(c.storage.endpoint);
      if (
        endpoint.protocol !== "https:" ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        endpoint.pathname !== "/"
      )
        throw Error("HTTPS storage origin required");
      for (const variable of [
        c.storage.accessKeyEnv,
        c.storage.secretKeyEnv,
        ...(c.storage.sessionTokenEnv ? [c.storage.sessionTokenEnv] : []),
      ])
        if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(variable))
          throw Error("Invalid storage credential variable");
      if (
        !c.storage.bucket ||
        !c.storage.prefix ||
        !/^[a-z0-9-]{1,64}$/.test(c.storage.region)
      )
        throw Error("Invalid storage scope");
    } else throw Error("Unknown storage kind");
  }
  if (
    c.automaticCollection !== undefined &&
    typeof c.automaticCollection !== "boolean"
  )
    throw Error("Invalid collection policy");
  for (const [name, minimum, maximum] of [
    ["port", 1, 65535],
    ["hostsPerOwner", 1, 64],
    ["maxSandboxesPerOwner", 1, 1000000],
    ["checkpointPackBytes", 0, 8388608],
    ["checkpointFrameBytes", 262144, 1048576],
    ["commandStartWaitMs", 0, 1000],
    ["inlineCommandOutputBytes", 0, 8192],
  ] as const) {
    const n = c[name];
    if (
      n !== undefined &&
      (!Number.isSafeInteger(n) || n < minimum || n > maximum)
    )
      throw Error(`Invalid ${name}`);
  }
  if (
    c.checkpointFrameBytes !== undefined &&
    ![262144, 524288, 1048576].includes(c.checkpointFrameBytes)
  )
    throw Error("Invalid frame size");
  if (
    c.host !== undefined &&
    !["127.0.0.1", "::1", "0.0.0.0", "::"].includes(c.host)
  )
    throw Error("Invalid bind address");
  if (c.workloadResources !== undefined) workloadResources(c.workloadResources);
  hostLifecycle(c.hostLifecycle);
  const ports = [c.port ?? 8788];
  for (const gateway of [c.sshGateway, c.preview]) {
    if (!gateway) continue;
    if (
      !Number.isSafeInteger(gateway.port) ||
      gateway.port < 1 ||
      gateway.port > 65535 ||
      ports.includes(gateway.port)
    )
      throw Error("Invalid or conflicting gateway port");
    ports.push(gateway.port);
  }
  return c;
}
