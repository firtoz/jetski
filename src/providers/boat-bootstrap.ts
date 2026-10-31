import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { StateStore } from "../core/contracts.js";
import { identifier } from "../core/contracts.js";
import { BoatControlChannel } from "../transport/boat-channel.js";
import type { BoatApi } from "./boat.js";

const modules = [
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
  "runtime.py",
  "runtime_service.py",
  "supervisor.py",
];
const root = new URL("../../host/", import.meta.url);
const digest = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
/** Node-only bootstrap of owned Boat machines. No credentials enter the bundle. */
export class BoatBootstrap {
  private readonly channel: BoatControlChannel;
  constructor(
    private readonly state: StateStore,
    api: BoatApi,
    private readonly poolId: string,
    private readonly images: string[],
  ) {
    identifier(poolId);
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
    const files: Record<string, string> = {};
    for (const name of modules) {
      const bytes = await readFile(
        new URL(name.endsWith(".c") ? `native/${name}` : name, root),
      );
      if (!bytes.length || bytes.length > 256 * 1024)
        throw Error("Bootstrap module bound");
      files[name] = bytes.toString("base64");
    }
    const installer = await readFile(new URL("install_bundle.py", root));
    if (installer.length > 32 * 1024) throw Error("Bootstrap installer bound");
    const bundle = Buffer.from(
      JSON.stringify({
        version: 1,
        config: {
          version: 1,
          machineId: host,
          poolId: this.poolId,
          images: this.images,
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
    const prepare =
      'import shutil,subprocess; tools=("podman","newuidmap","newgidmap","runuser","useradd","loginctl","systemctl","slirp4netns","fuse-overlayfs","dbus-run-session","cc"); missing=any(shutil.which(t) is None for t in tools); subprocess.run(["apt-get","update","-qq"],check=True) if missing else None; subprocess.run(["apt-get","install","-y","--no-install-recommends","podman","uidmap","slirp4netns","fuse-overlayfs","dbus-user-session","gcc","libc6-dev"],check=True) if missing else None';
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
