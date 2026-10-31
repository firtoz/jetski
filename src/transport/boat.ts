import { identifier, type StateStore } from "../core/contracts.js";
import {
  HOST_PROTOCOL_VERSION,
  type HostRequest,
  type HostResponse,
  type HostTransport,
  HostTransportError,
} from "../core/transport.js";
import type { BoatAllocation, BoatApi } from "../providers/boat.js";

/** No workload shell is exposed. Only the fixed installed host-control program
 * receives an encoded protocol request; remote ambiguity never causes a replay. */
export class BoatTransport implements HostTransport {
  constructor(
    private readonly state: StateStore,
    private readonly api: BoatApi,
    private readonly timeoutSeconds = 60,
  ) {
    if (
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > 600
    )
      throw Error("Invalid Boat command deadline");
  }
  async request(
    host: string,
    request: HostRequest,
    signal?: AbortSignal,
  ): Promise<HostResponse> {
    identifier(host);
    identifier(request.id);
    identifier(request.action);
    if (request.version !== HOST_PROTOCOL_VERSION)
      throw Error("Unsupported host protocol");
    const input = Buffer.from(JSON.stringify(request), "utf8");
    if (input.length > 1024 * 1024) throw Error("Host request too large");
    signal?.throwIfAborted();
    await this.state.transaction((tx) => {
      const key = tx.get<string>(`boat-host/${host}`);
      const allocation = key ? tx.get<BoatAllocation>(key) : undefined;
      if (!allocation || allocation.id !== host || allocation.retired)
        throw Error("Boat host is not actively owned");
    });
    const execute = async (command: string, commandSignal?: AbortSignal) => {
      const reply = await this.api.call(
        `/sandboxes/${host}/commands`,
        "POST",
        {
          command,
          timeoutSeconds: this.timeoutSeconds,
          detached: false,
          stream: false,
        },
        {},
        {
          maxBytes: 8 * 1024 * 1024,
          timeoutMs: (this.timeoutSeconds + 65) * 1000,
          ...(commandSignal ? { signal: commandSignal } : {}),
        },
      );
      const value = reply.value;
      if (
        reply.status !== 200 ||
        value.ok === false ||
        value.success !== true ||
        value.exitCode !== 0 ||
        value.timedOut !== false ||
        value.stdoutTruncated === true ||
        value.stderrTruncated === true ||
        typeof value.stdout !== "string" ||
        typeof value.stderr !== "string" ||
        Buffer.byteLength(value.stdout) > 2 * 1024 * 1024 ||
        Buffer.byteLength(value.stderr) > 64 * 1024
      )
        throw Error("Invalid command completion");
      return value.stdout;
    };
    let directory: string | undefined;
    try {
      signal?.throwIfAborted();
      let stdout: string;
      if (input.length <= 48 * 1024) {
        stdout = await execute(
          `printf '%s' '${input.toString("base64")}' | base64 -d | env -i PATH=/usr/bin:/bin python3 -I /opt/jetski/host/control.py`,
          signal,
        );
      } else {
        // Linux limits a single shell argument. Large inputs travel through the
        // file API inside an exclusively created private directory, not argv.
        directory = `/tmp/jetski-control-${crypto.randomUUID()}`;
        const path = `${directory}/request.json`;
        await execute(
          `env -i PATH=/usr/bin:/bin python3 -I -c 'import os; os.mkdir("${directory}", 0o700)'`,
          signal,
        );
        const uploaded = await this.api.call(
          `/sandboxes/${host}/files`,
          "PUT",
          {
            path,
            content: input.toString("base64"),
            encoding: "base64",
          },
          {},
          { ...(signal ? { signal } : {}) },
        );
        if (
          uploaded.status !== 200 ||
          uploaded.value.success !== true ||
          uploaded.value.path !== path ||
          uploaded.value.size !== input.length
        )
          throw Error("Invalid control upload receipt");
        const digest = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", input)),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        stdout = await execute(
          `env -i PATH=/usr/bin:/bin python3 -I -c 'import hashlib,os,subprocess,sys; f=os.open("${path}",os.O_RDONLY|os.O_NOFOLLOW); data=os.fdopen(f,"rb").read(1048577); assert len(data)==${input.length} and hashlib.sha256(data).hexdigest()=="${digest}"; sys.exit(subprocess.run(["/usr/bin/python3","-I","/opt/jetski/host/control.py"],input=data,env={"PATH":"/usr/bin:/bin"}).returncode)'`,
          signal,
        );
      }

      const response = JSON.parse(stdout) as HostResponse;
      if (
        !response ||
        response.version !== HOST_PROTOCOL_VERSION ||
        response.id !== request.id ||
        !Object.hasOwn(response, "result")
      )
        throw Error("Invalid host response");
      return response;
    } catch {
      throw new HostTransportError(
        "Boat host control failed; remote completion unknown",
      );
    } finally {
      if (directory) {
        try {
          // A fresh unguessable directory belongs only to this invocation. Never
          // recursively delete it; unexpected contents must make cleanup fail.
          await execute(
            `env -i PATH=/usr/bin:/bin python3 -I -c 'import os,stat; f=os.open("${directory}",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW); s=os.fstat(f); assert s.st_uid==os.geteuid() and stat.S_IMODE(s.st_mode)==0o700; names=os.listdir(f); assert all(n=="request.json" for n in names); os.unlink("request.json",dir_fd=f) if names else None; os.close(f); os.rmdir("${directory}")'`,
          );
        } catch {
          throw new HostTransportError(
            "Boat control cleanup uncertain; inspect host before reuse",
          );
        }
      }
    }
  }
}
