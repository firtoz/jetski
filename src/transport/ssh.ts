import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { identifier } from "../core/contracts.js";
import type {
  HostConnection,
  HostStreamRequest,
  HostStreamTransport,
} from "../core/host-stream.js";
import { tcpPort } from "../core/ports.js";
import { STREAM_MAGIC } from "../core/stream-protocol.js";
import {
  HOST_CONTROL_TIMEOUT_MS,
  HOST_PROTOCOL_VERSION,
  type HostRequest,
  type HostResponse,
  type HostTransport,
  HostTransportError,
} from "../core/transport.js";
import { attachHostStream } from "./host-stream.js";

export type SshHost = {
  id: string;
  hostname: string;
  port: number;
  user: string;
  privateKeyPath: string;
  knownHostsPath: string;
};
export function sshArguments(host: SshHost): string[] {
  identifier(host.id);
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(host.hostname) ||
    !/^[a-z_][a-z0-9_-]*$/.test(host.user)
  )
    throw new Error("Invalid SSH host");
  if (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535)
    throw new Error("Invalid SSH port");
  if (
    ![host.privateKeyPath, host.knownHostsPath].every(
      (path) => isAbsolute(path) && !/[\r\n\0]/.test(path),
    )
  )
    throw new Error("SSH credentials require explicit absolute paths");
  return [
    "-F",
    "/dev/null",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${host.knownHostsPath}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=10",
    "-o",
    "ServerAliveCountMax=2",
    "-i",
    host.privateKeyPath,
    "-p",
    String(host.port),
    `${host.user}@${host.hostname}`,
    "env -i PATH=/usr/bin:/bin python3 -I /opt/jetski/host/control.py",
  ];
}
export class SshTransport implements HostTransport, HostStreamTransport {
  private readonly hosts: Map<string, SshHost>;
  constructor(
    hosts: SshHost[],
    private readonly timeoutMs = HOST_CONTROL_TIMEOUT_MS,
  ) {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 600_000
    )
      throw new Error("Invalid transport timeout");
    this.hosts = new Map();
    for (const host of hosts) {
      sshArguments(host);
      if (this.hosts.has(host.id)) throw new Error("Duplicate SSH host");
      this.hosts.set(host.id, structuredClone(host));
    }
  }
  async open(
    hostId: string,
    request: HostStreamRequest,
    signal?: AbortSignal,
  ): Promise<HostConnection> {
    const host = this.hosts.get(hostId);
    if (!host) throw Error("SSH host not configured");
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        request.streamId,
      )
    )
      throw Error("Canonical stream UUID required");
    tcpPort(request.port);
    if (request.lease.machineId !== hostId) throw Error("Stream host mismatch");
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
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const child = spawn("ssh", sshArguments(host), {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
    });
    let stderrBytes = 0;
    const closed = new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
      child.stderr.on("data", (bytes: Buffer) => {
        stderrBytes += bytes.length;
        if (stderrBytes > 65536)
          reject(new HostTransportError("Host diagnostic bound exceeded"));
      });
    });
    return attachHostStream(
      {
        input: child.stdin,
        output: child.stdout,
        closed,
        terminate: () => {
          child.kill("SIGKILL");
        },
      },
      Buffer.concat([Buffer.from(STREAM_MAGIC), length, body]),
      signal,
    );
  }
  async request(
    hostId: string,
    request: HostRequest,
    signal?: AbortSignal,
  ): Promise<HostResponse> {
    const host = this.hosts.get(hostId);
    if (!host) throw new Error("SSH host not configured");
    if (request.version !== HOST_PROTOCOL_VERSION)
      throw new Error("Unsupported host protocol");
    identifier(request.id);
    identifier(request.action);
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > 1024 * 1024)
      throw new Error("Host request too large");
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn("ssh", sshArguments(host), {
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
      });
      let output = Buffer.alloc(0),
        stderrBytes = 0,
        settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill("SIGKILL");
        reject(new HostTransportError(message));
      };
      const abort = () =>
        fail("Host request aborted; remote completion unknown");
      const timer = setTimeout(
        () => fail("Host request timed out; remote completion unknown"),
        this.timeoutMs,
      );
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.on("error", () => fail("SSH transport failed"));
      child.stdin.on("error", () => fail("SSH request delivery failed"));
      child.stdout.on("data", (chunk: Buffer) => {
        if (output.length + chunk.length > 2 * 1024 * 1024) {
          fail("Host response bound exceeded");
          return;
        }
        output = Buffer.concat([output, chunk]);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 64 * 1024) fail("Host diagnostic bound exceeded");
      });
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          fail("Host control failed; inspect operation before retry");
          return;
        }
        try {
          const response = JSON.parse(output.toString("utf8")) as HostResponse;
          if (
            !response ||
            response.version !== HOST_PROTOCOL_VERSION ||
            response.id !== request.id ||
            !Object.hasOwn(response, "result")
          )
            throw new Error("Invalid host response");
          settled = true;
          cleanup();
          resolve(response);
        } catch {
          fail("Invalid host response; remote completion unknown");
        }
      });
      child.stdin.end(input);
    });
  }
}
