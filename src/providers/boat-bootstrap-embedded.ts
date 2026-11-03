import { createHash } from "node:crypto";
import type { StateStore } from "../core/contracts.js";
import {
  identifier,
  RUNTIME_NETWORK_MODES,
  RUNTIME_STORAGE_MODES,
  type RuntimeNetworkMode,
  type RuntimeStorageMode,
} from "../core/contracts.js";
import { BoatControlChannel } from "../transport/boat-channel.js";
import {
  bindHostBackend,
  type HostBackend,
  PYTHON_HOST_BACKEND,
  validateHostBackend,
} from "../transport/host-backend.js";
import type { BoatApi } from "./boat.js";
import { BOAT_PREREQUISITES } from "./boat-prerequisites.js";

export const BOAT_BOOTSTRAP_MODULES = Object.freeze([
  "archive.py",
  "bootstrap.py",
  "commands.py",
  "terminal_input.py",
  "streams.py",
  "stream_protocol.py",
  "stream_broker.py",
  "podman_exec.py",
  "command-supervisor.c",
  "tcp-relay.c",
  "control.py",
  "fence.py",
  "file_upload.py",
  "files.py",
  "frames.py",
  "import_checkpoint.py",
  "local_checkpoint.py",
  "checkpoint_export.py",
  "runtime.py",
  "runtime_backend.py",
  "runtime_service.py",
  "supervisor.py",
]);
export type BoatBootstrapAssets = {
  files: Readonly<Record<string, Uint8Array>>;
  installer: Uint8Array;
};
const digest = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
/** Injected immutable source assets; no controller filesystem or credentials in the bundle. */
export class EmbeddedBoatBootstrap {
  private readonly channel: BoatControlChannel;
  constructor(
    private readonly state: StateStore,
    api: BoatApi,
    private readonly poolId: string,
    private readonly images: string[],
    private readonly loadAssets: () => Promise<BoatBootstrapAssets>,
    private readonly networkMode: RuntimeNetworkMode = "none",
    private readonly storageMode: RuntimeStorageMode = "default",
    private readonly backend: HostBackend = PYTHON_HOST_BACKEND,
  ) {
    validateHostBackend(backend);
    this.backend = structuredClone(backend);
    identifier(poolId);
    if (!RUNTIME_STORAGE_MODES.includes(storageMode))
      throw Error("Unsupported runtime storage policy");
    if (!RUNTIME_NETWORK_MODES.includes(networkMode))
      throw Error("Unsupported runtime network policy");
    if (
      !Array.isArray(images) ||
      images.length < 1 ||
      images.length > 32 ||
      images.some(
        (image) =>
          !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(image),
      )
    )
      throw Error("Approved digest-pinned images required");
    this.images = [...images];
    this.channel = new BoatControlChannel(state, api, 600);
  }
  async ensure(host: string): Promise<void> {
    identifier(host);
    await bindHostBackend(this.state, host, this.backend);
    const assets = await this.loadAssets();
    if (
      Object.keys(assets.files).length !== BOAT_BOOTSTRAP_MODULES.length ||
      Object.keys(assets.files).some(
        (name) => !BOAT_BOOTSTRAP_MODULES.includes(name),
      )
    )
      throw Error("Bootstrap module set mismatch");
    const files: Record<string, string> = {};
    for (const name of BOAT_BOOTSTRAP_MODULES) {
      const source = assets.files[name];
      if (!(source instanceof Uint8Array))
        throw Error("Bootstrap module bytes required");
      const bytes = Buffer.from(source);
      if (!bytes.length || bytes.length > 256 * 1024)
        throw Error("Bootstrap module bound");
      files[name] = bytes.toString("base64");
    }
    if (!(assets.installer instanceof Uint8Array))
      throw Error("Bootstrap installer bytes required");
    const installer = Buffer.from(assets.installer);
    if (!installer.length || installer.length > 32 * 1024)
      throw Error("Bootstrap installer bound");
    const bundle = Buffer.from(
      JSON.stringify({
        version: 1,
        config: {
          version: 1,
          machineId: host,
          archiveTransferUser: "user",
          poolId: this.poolId,
          images: this.images,
          ...(this.storageMode === "default"
            ? {}
            : { storageMode: this.storageMode }),
          ...(this.networkMode === "none"
            ? {}
            : { networkMode: this.networkMode }),
        },
        files,
      }),
    );
    if (bundle.length > 1024 * 1024) throw Error("Bootstrap bundle bound");
    const identity = { bundle: digest(bundle), installer: digest(installer) };
    const key = `boat-bootstrap/${host}`;
    const complete = await this.state.transaction((tx) => {
      const prior = tx.get<{
        bundle: string;
        installer: string;
        ready: boolean;
      }>(key);
      if (
        prior &&
        (prior.bundle !== identity.bundle ||
          prior.installer !== identity.installer)
      )
        throw Error(
          "Bootstrap identity changed; explicit host replacement required",
        );
      tx.put(key, { ...identity, ready: prior?.ready ?? false });
      return prior?.ready === true;
    });
    if (complete) return;
    // Only install missing prerequisites on the allocated machine. Do not upgrade
    // unrelated system packages. This program never runs on the controller host.
    const prepare = BOAT_PREREQUISITES;
    const rootProgram = [
      "sudo",
      "-n",
      "env",
      "-i",
      "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
      "DEBIAN_FRONTEND=noninteractive",
      "python3",
      "-I",
      "-c",
    ];
    // Boat's stock /opt belongs to its trusted guest account. Secure that
    // install parent only before our first installation on this owned machine.
    // Adopted SSH hosts still require operator preparation; never repair assigned
    // or already-installed hosts by changing their filesystem permissions.
    const backendGuard =
      this.backend.kind === "python"
        ? 'assert not os.path.lexists("/var/lib/jetski-native/intent.json"), "native_host_requires_native_backend"'
        : `import json; assert json.load(open("/var/lib/jetski-native/intent.json"))["sha256"]=="${this.backend.sha256}", "native_backend_intent_mismatch"`;
    const secureParent = `import os,stat
${backendGuard}
root=os.stat("/",follow_symlinks=False)
assert stat.S_ISDIR(root.st_mode) and root.st_uid==0 and not root.st_mode & 0o022
fd=os.open("/opt",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 meta=os.fstat(fd)
 if meta.st_uid!=0 or meta.st_mode & 0o022:
  assert not any(os.path.lexists(p) for p in ("/opt/jetski","/etc/jetski/host.json","/var/lib/jetski/control/slot/state.json")), "existing_install_requires_reconciliation"
  os.fchown(fd,0,0)
  os.fchmod(fd,stat.S_IMODE(meta.st_mode) & ~0o022)
finally:
 os.close(fd)`;
    await this.channel.run(host, Buffer.alloc(0), [
      ...rootProgram,
      secureParent,
    ]);
    await this.channel.run(host, Buffer.alloc(0), [...rootProgram, prepare]);
    const program = `exec(bytes.fromhex("${installer.toString("hex")}"))`;
    const output = await this.channel.run(host, bundle, [
      ...rootProgram,
      program,
    ]);
    const receipt = JSON.parse(output.trim().split("\n").at(-1)!);
    if (
      receipt.version !== 1 ||
      receipt.digest !== identity.bundle ||
      receipt.machineId !== host ||
      receipt.ready !== true
    )
      throw Error("Bootstrap readiness receipt mismatch");
    await this.state.transaction((tx) => {
      const prior = tx.get<{
        bundle: string;
        installer: string;
        ready: boolean;
      }>(key);
      if (
        !prior ||
        prior.bundle !== identity.bundle ||
        prior.installer !== identity.installer
      )
        throw Error("Bootstrap completion fenced");
      tx.put(key, { ...prior, ready: true });
    });
  }
}
