import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { StateStore } from "../core/contracts.js";
import { identifier } from "../core/contracts.js";
import type { BoxdControlChannel } from "../transport/boxd.js";
import { BOAT_BOOTSTRAP_MODULES } from "./boat-bootstrap-embedded.js";
import { BOAT_PREREQUISITES } from "./boat-prerequisites.js";

/** Same ordinary host sources and fenced installer used by cloud bootstrap.
 * Only call through an owned-machine channel, never on an operator desktop. */
export class OwnedMachineBootstrap {
  constructor(
    private state: StateStore,
    private channel: Pick<BoxdControlChannel, "run">,
    private poolId: string,
    private images: string[],
    private transferUser: string,
  ) {
    identifier(poolId);
    if (!/^[a-z_][a-z0-9_-]*$/.test(transferUser))
      throw Error("Invalid transfer account");
  }
  async ensure(host: string) {
    identifier(host);
    const root = new URL("../../host/", import.meta.url),
      files: Record<string, string> = {};
    for (const name of BOAT_BOOTSTRAP_MODULES) {
      const bytes = await readFile(
        new URL(name.endsWith(".c") ? `native/${name}` : name, root),
      );
      if (!bytes.length || bytes.length > 256 * 1024)
        throw Error("Bootstrap module bound");
      files[name] = bytes.toString("base64");
    }
    const installer = await readFile(new URL("install_bundle.py", root));
    if (!installer.length || installer.length > 32 * 1024)
      throw Error("Bootstrap installer bound");
    const bundle = Buffer.from(
      JSON.stringify({
        version: 1,
        config: {
          version: 1,
          machineId: host,
          poolId: this.poolId,
          archiveTransferUser: this.transferUser,
          images: this.images,
        },
        files,
      }),
    );
    if (bundle.length > 1024 * 1024) throw Error("Bootstrap bundle bound");
    const sha = (bytes: Uint8Array) =>
      createHash("sha256").update(bytes).digest("hex");
    const identity = { bundle: sha(bundle), installer: sha(installer) };
    const key = `machine-bootstrap/${this.poolId}/${host}`;
    const completed = await this.state.transaction((tx) => {
      const previous = tx.get<{
        bundle: string;
        installer: string;
        ready: boolean;
      }>(key);
      if (
        previous &&
        (previous.bundle !== identity.bundle ||
          previous.installer !== identity.installer)
      )
        throw Error("Bootstrap identity changed; replace the host");
      tx.put(key, { ...identity, ready: previous?.ready ?? false });
      return previous?.ready === true;
    });
    const program = [
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
    if (!completed) {
      await this.channel.run(host, [
        ...program,
        `import os,stat
assert not os.path.lexists('/var/lib/jetski-native/intent.json'), 'native_backend_requires_explicit_selection'
root=os.stat('/',follow_symlinks=False)
assert stat.S_ISDIR(root.st_mode) and root.st_uid==0 and not root.st_mode & 0o022
fd=os.open('/opt',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 meta=os.fstat(fd)
 if meta.st_uid!=0 or meta.st_mode & 0o022:
  assert not any(os.path.lexists(p) for p in ('/opt/jetski','/etc/jetski/host.json','/var/lib/jetski/control/slot/state.json')), 'existing_install_requires_reconciliation'
  os.fchown(fd,0,0);os.fchmod(fd,stat.S_IMODE(meta.st_mode)&~0o022)
finally:os.close(fd)`,
      ]);
      await this.channel.run(host, [...program, BOAT_PREREQUISITES]);
      const result = await this.channel.run(
        host,
        [...program, `exec(bytes.fromhex("${installer.toString("hex")}"))`],
        bundle,
      );
      const receipt = JSON.parse(
        new TextDecoder("utf-8", { fatal: true })
          .decode(result.stdout)
          .trim()
          .split("\n")
          .at(-1)!,
      );
      if (
        receipt.version !== 1 ||
        receipt.digest !== identity.bundle ||
        receipt.machineId !== host ||
        receipt.ready !== true
      )
        throw Error("Bootstrap receipt mismatch");
      await this.state.transaction((tx) => {
        const previous = tx.get<{
          bundle: string;
          installer: string;
          ready: boolean;
        }>(key);
        if (
          !previous ||
          previous.bundle !== identity.bundle ||
          previous.installer !== identity.installer
        )
          throw Error("Bootstrap completion fenced");
        tx.put(key, { ...previous, ready: true });
      });
    }
    // A running provider VM and controller receipt alone do not prove readiness.
    const id = crypto.randomUUID(),
      result = await this.channel.run(
        host,
        [
          "sudo",
          "-n",
          "env",
          "-i",
          "PATH=/usr/bin:/bin",
          "python3",
          "-I",
          "/opt/jetski/host/control.py",
        ],
        Buffer.from(
          JSON.stringify({ version: 1, id, action: "status", payload: null }),
        ),
      );
    const proof = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(result.stdout),
    );
    if (
      proof.version !== 1 ||
      proof.id !== id ||
      proof.result?.ready !== true ||
      proof.result.machineId !== host ||
      proof.result.poolId !== this.poolId
    )
      throw Error("Host readiness identity mismatch");
  }
}
