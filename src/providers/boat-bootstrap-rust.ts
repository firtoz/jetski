import { createHash } from "node:crypto";
import type {
  RuntimeNetworkMode,
  RuntimeStorageMode,
  StateStore,
} from "../core/contracts.js";
import { BoatControlChannel } from "../transport/boat-channel.js";
import {
  bindHostBackend,
  type HostBackend,
} from "../transport/host-backend.js";
import type { BoatApi } from "./boat.js";
import {
  type BoatBootstrapAssets,
  EmbeddedBoatBootstrap,
} from "./boat-bootstrap-embedded.js";

export type RustHostAssets = {
  binary: Uint8Array;
  sha256: string;
  installer: Uint8Array;
};
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
/** Opt-in sidecar artifact. The base prerequisite/image bootstrap stays unchanged. */
export class RustBoatBootstrap {
  private readonly channel: BoatControlChannel;
  constructor(
    private readonly state: StateStore,
    private readonly api: BoatApi,
    private readonly poolId: string,
    private readonly images: string[],
    private readonly baseAssets: () => Promise<BoatBootstrapAssets>,
    private readonly nativeAssets: () => Promise<RustHostAssets>,
    private readonly networkMode: RuntimeNetworkMode = "none",
    private readonly storageMode: RuntimeStorageMode = "default",
  ) {
    this.channel = new BoatControlChannel(state, api, 600);
    this.images = [...images];
  }
  async ensure(host: string): Promise<void> {
    const assets = await this.nativeAssets();
    if (
      !(assets.binary instanceof Uint8Array) ||
      assets.binary.length < 64 ||
      assets.binary.length > 6 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(assets.sha256) ||
      digest(assets.binary) !== assets.sha256 ||
      !(assets.installer instanceof Uint8Array) ||
      !assets.installer.length ||
      assets.installer.length > 32 * 1024
    )
      throw Error("Invalid pinned native assets");
    const backend: HostBackend = { kind: "rust", sha256: assets.sha256 };
    const base = new EmbeddedBoatBootstrap(
      this.state,
      this.api,
      this.poolId,
      this.images,
      this.baseAssets,
      this.networkMode,
      this.storageMode,
      backend,
    );
    await bindHostBackend(this.state, host, backend);
    const identity = {
      version: 1,
      backend: "rust",
      sha256: assets.sha256,
      bytes: assets.binary.length,
      machineId: host,
      poolId: this.poolId,
    };
    const key = `rust-bootstrap/${host}`;
    const installer = digest(assets.installer);
    const done = await this.state.transaction((tx) => {
      const prior = tx.get<{
        sha256: string;
        installer: string;
        ready: boolean;
      }>(key);
      if (
        prior &&
        (prior.sha256 !== assets.sha256 || prior.installer !== installer)
      )
        throw Error("Native bootstrap changed; explicit replacement required");
      tx.put(key, {
        sha256: assets.sha256,
        installer,
        ready: prior?.ready ?? false,
      });
      return prior?.ready === true;
    });
    if (done) {
      await base.ensure(host);
      return;
    }
    const program = `exec(bytes.fromhex("${Buffer.from(assets.installer).toString("hex")}"))`;
    const run = async (action: "prepare" | "install") => {
      const output = await this.channel.run(
        host,
        Buffer.from(JSON.stringify({ action, identity })),
        [
          "sudo",
          "-n",
          "env",
          "-i",
          "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
          "python3",
          "-I",
          "-c",
          program,
        ],
      );
      const receipt = JSON.parse(output.trim().split("\n").at(-1)!);
      if (
        receipt.sha256 !== identity.sha256 ||
        receipt.machineId !== host ||
        receipt.poolId !== this.poolId ||
        receipt.bytes !== identity.bytes ||
        (action === "prepare" && receipt.prepared !== true) ||
        (action === "install" && receipt.ready !== true)
      )
        throw Error("Native installation receipt mismatch");
    };
    await run("prepare");
    await base.ensure(host);
    await this.api.uploadFile(
      host,
      `/tmp/jetski-native-${assets.sha256}.bin`,
      assets.binary,
    );
    await run("install");
    await this.state.transaction((tx) => {
      const prior = tx.get<{
        sha256: string;
        installer: string;
        ready: boolean;
      }>(key);
      if (
        !prior ||
        prior.sha256 !== assets.sha256 ||
        prior.installer !== installer
      )
        throw Error("Native completion fenced");
      tx.put(key, { ...prior, ready: true });
    });
  }
}
