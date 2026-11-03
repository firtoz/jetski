/** Optional Boat stream channel. Provider-authenticated host keys are pinned in
 * controller state; private credentials never enter a workload or public receipt. */
import { isIP } from "node:net";
import ssh2 from "ssh2";
import { identifier, type StateStore } from "../core/contracts.js";
import type {
  HostConnection,
  HostStreamRequest,
  HostStreamTransport,
} from "../core/host-stream.js";
import { tcpPort } from "../core/ports.js";
import { STREAM_MAGIC } from "../core/stream-protocol.js";
import {
  HOST_PROTOCOL_VERSION,
  HostTransportError,
} from "../core/transport.js";
import type { BoatAllocation, BoatApi } from "../providers/boat.js";
import {
  bindHostBackend,
  type HostBackend,
  hostControlCommand,
  PYTHON_HOST_BACKEND,
  validateHostBackend,
} from "./host-backend.js";
import { attachHostStream, type StreamWire } from "./host-stream.js";
import { sshKeyPair } from "./ssh-key.js";

type Credentials = { public: string; private: string; hostKey: string | null };

/** Operator-selected compatibility suite. Never supplied by a workload request. */
export const BOAT_STREAM_CRYPTO_SUITES = [
  "default",
  "aes256-ctr-sha256-etm",
] as const;
export type BoatStreamCryptoSuite = (typeof BOAT_STREAM_CRYPTO_SUITES)[number];
export type BoatStreamOptions = {
  cryptoSuite?: BoatStreamCryptoSuite;
  backend?: HostBackend;
};

export class BoatStreamTransport implements HostStreamTransport {
  private readonly cryptoSuite: BoatStreamCryptoSuite;
  private readonly backend: HostBackend;
  constructor(
    private readonly state: StateStore,
    private readonly api: BoatApi,
    options: BoatStreamOptions = {},
  ) {
    this.backend = structuredClone(options.backend ?? PYTHON_HOST_BACKEND);
    validateHostBackend(this.backend);
    if (
      options.cryptoSuite !== undefined &&
      !BOAT_STREAM_CRYPTO_SUITES.includes(options.cryptoSuite)
    )
      throw Error("Unsupported Boat stream crypto suite");
    this.cryptoSuite = options.cryptoSuite ?? "default";
  }

  async open(
    host: string,
    request: HostStreamRequest,
    signal?: AbortSignal,
  ): Promise<HostConnection> {
    await bindHostBackend(this.state, host, this.backend);
    identifier(host);
    if (request.lease.machineId !== host) throw Error("Stream host mismatch");
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        request.streamId,
      )
    )
      throw Error("Canonical stream UUID required");
    tcpPort(request.port);
    const body = Buffer.from(
      JSON.stringify({
        version: HOST_PROTOCOL_VERSION,
        id: request.streamId,
        action: "stream-open",
        payload: request,
      }),
    );
    if (body.length > 16384) throw Error("Stream header bound exceeded");
    signal?.throwIfAborted();
    const credentialKey = `boat-ssh/${host}`;
    const checkOwned = (allocation: BoatAllocation | undefined) => {
      if (
        !allocation ||
        allocation.id !== host ||
        allocation.retired ||
        allocation.owner !== request.lease.owner ||
        !Number.isSafeInteger(allocation.expiresAt) ||
        allocation.expiresAt <= Date.now()
      )
        throw Error("Boat stream host is not actively owned");
    };
    const credentials = await this.state.transaction((tx) => {
      const key = tx.get<string>(`boat-host/${host}`);
      checkOwned(key ? tx.get<BoatAllocation>(key) : undefined);
      const prior = tx.get<Credentials>(credentialKey);
      if (prior) return prior;
      const created: Credentials = { ...sshKeyPair(), hostKey: null };
      tx.put(credentialKey, created);
      return created;
    });
    // Register the same public key after an uncertain response, never a new key.
    const reply = await this.api.call(
      `/sandboxes/${host}/sshkey`,
      "POST",
      { key: credentials.public },
      {},
      { maxBytes: 16384, ...(signal ? { signal } : {}) },
    );
    const value = reply.value;
    if (
      reply.status !== 200 ||
      value.success !== true ||
      value.sshUser !== "user" ||
      typeof value.hostKey !== "string" ||
      value.hostKey.length > 8192 ||
      /[\r\n]/.test(value.hostKey)
    )
      throw Error("Invalid Boat SSH registration");
    const parsed = ssh2.utils.parseKey(value.hostKey);
    if (
      parsed instanceof Error ||
      Array.isArray(parsed) ||
      parsed.isPrivateKey()
    )
      throw Error("Invalid Boat SSH host key");
    const hostKey = parsed.getPublicSSH().toString("base64");
    let hostname: string,
      port = 22;
    if (typeof value.sshEndpoint === "string" && value.sshEndpoint) {
      const endpoint = /^(\d+\.\d+\.\d+\.\d+):(\d{1,5})$/.exec(
        value.sshEndpoint,
      );
      if (!endpoint || isIP(endpoint[1]!) !== 4)
        throw Error("Invalid Boat SSH endpoint");
      hostname = endpoint[1]!;
      port = Number(endpoint[2]);
      tcpPort(port);
    } else {
      if (typeof value.machineIp !== "string" || !isIP(value.machineIp))
        throw Error("Invalid Boat SSH address");
      hostname = value.machineIp;
    }
    await this.state.transaction((tx) => {
      const key = tx.get<string>(`boat-host/${host}`);
      checkOwned(key ? tx.get<BoatAllocation>(key) : undefined);
      const current = tx.get<Credentials>(credentialKey);
      if (
        !current ||
        current.public !== credentials.public ||
        (current.hostKey !== null && current.hostKey !== hostKey)
      )
        throw Error("Boat SSH host key changed; reconciliation required");
      tx.put(credentialKey, { ...current, hostKey });
    });
    signal?.throwIfAborted();
    const client = new ssh2.Client();
    const wire = await new Promise<StreamWire>((resolve, reject) => {
      let admitted = false;
      let rejectClosed: (error: Error) => void = () => {};
      const error = () => {
        const failure = new HostTransportError(
          "Boat SSH failed; inspect stream receipt before retry",
        );
        if (admitted) rejectClosed(failure);
        else reject(failure);
        client.destroy();
        cleanup();
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", error);
      };
      const timer = setTimeout(error, 15000);
      signal?.addEventListener("abort", error, { once: true });
      client.on("error", error);
      client.on("close", () => {
        cleanup();
        if (!admitted)
          reject(new HostTransportError("Boat SSH closed before admission"));
      });
      client.once("ready", () => {
        client.exec(
          `sudo -n ${hostControlCommand(this.backend)}`,
          (err, channel) => {
            if (err) {
              error();
              return;
            }
            admitted = true;
            cleanup();
            let exitCode: number | null = null,
              diagnostics = 0;
            const closed = new Promise<number | null>((done, fail) => {
              rejectClosed = fail;
              channel.on("exit", (code: number | null) => {
                exitCode = code;
              });
              channel.on("close", () => {
                done(exitCode);
                client.end();
              });
              channel.on("error", error);
              channel.stderr.on("data", (bytes: Buffer) => {
                diagnostics += bytes.length;
                if (diagnostics > 65536) error();
              });
              client.once("close", () => done(null));
            });
            void closed.catch(() => {});
            resolve({
              input: channel,
              output: channel,
              closed,
              terminate: () => client.destroy(),
            });
          },
        );
      });
      client.connect({
        ...(this.cryptoSuite === "aes256-ctr-sha256-etm"
          ? {
              algorithms: {
                cipher: ["aes256-ctr"],
                hmac: ["hmac-sha2-256-etm@openssh.com"],
              },
            }
          : {}),
        host: hostname,
        port,
        username: "user",
        privateKey: credentials.private,
        readyTimeout: 10000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 2,
        hostVerifier: (key: Buffer) => key.toString("base64") === hostKey,
      });
      if (signal?.aborted) error();
    });
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    return attachHostStream(
      wire,
      Buffer.concat([Buffer.from(STREAM_MAGIC), length, body]),
      signal,
    );
  }
}
