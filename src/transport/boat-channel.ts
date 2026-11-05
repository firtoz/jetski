import { createHash } from "node:crypto";
import { posix } from "node:path";
import { identifier, type StateStore } from "../core/contracts.js";
import { observeHostTimings, type StageTimingSink } from "../core/timing.js";
import { HostTransportError } from "../core/transport.js";
import type { BoatAllocation, BoatApi } from "../providers/boat.js";
import { validateHostBackend } from "./host-backend.js";

const quote = (value: string) => `'${value}'`;
/** Internal owned-host channel. Programs come only from trusted controller code. */
export class BoatControlChannel {
  constructor(
    private readonly state: StateStore,
    private readonly api: BoatApi,
    private readonly timeoutSeconds = 60,
    private readonly nativeSha256?: string,
    private readonly timings?: StageTimingSink,
  ) {
    if (nativeSha256 !== undefined)
      validateHostBackend({ kind: "rust", sha256: nativeSha256 });
    if (
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > 600
    )
      throw Error("Invalid Boat command deadline");
  }
  async run(
    host: string,
    input: Buffer,
    program: string[],
    signal?: AbortSignal,
    inputLimit = 1024 * 1024,
    outputLimit = 2 * 1024 * 1024,
  ): Promise<string> {
    identifier(host);
    if (
      ![2 * 1024 * 1024, 8 * 1024 * 1024].includes(outputLimit) ||
      ![1024 * 1024, 6 * 1024 * 1024].includes(inputLimit) ||
      input.length > inputLimit
    )
      throw Error("Host request too large");
    // Program names/arguments are private fixed controller instructions; apostrophes
    // are excluded because the large-input verifier encloses its JSON in a literal.
    if (
      !program.length ||
      program.some((arg) => arg.includes("'") || arg.includes("\u0000"))
    )
      throw Error("Invalid control program");
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
          maxBytes: Math.max(8 * 1024 * 1024, outputLimit * 2 + 1024 * 1024),
          timeoutMs: (this.timeoutSeconds + 65) * 1000,
          ...(commandSignal ? { signal: commandSignal } : {}),
        },
      );
      const value = reply.value;
      if (this.timings && typeof value.stderr === "string")
        observeHostTimings(value.stderr, this.timings);
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
        Buffer.byteLength(value.stdout) > outputLimit ||
        Buffer.byteLength(value.stderr) > 64 * 1024
      )
        throw new HostTransportError("Boat command completion unconfirmed", {
          provider: "boat",
          code:
            typeof value.exitCode === "number" && value.exitCode !== 0
              ? "remote-exit"
              : "invalid-receipt",
          httpStatus: reply.status,
          ...(typeof value.exitCode === "number" &&
          Number.isSafeInteger(value.exitCode)
            ? { exitCode: value.exitCode }
            : {}),
        });
      return value.stdout;
    };
    let directory: string | undefined;
    const native = (action: string, ...args: string[]) =>
      [
        "sudo",
        "-n",
        "env",
        "-i",
        "PATH=/usr/bin:/bin",
        "/opt/jetski/native/jetski-host",
        action,
        this.nativeSha256!,
        ...args,
      ]
        .map(quote)
        .join(" ");
    try {
      signal?.throwIfAborted();
      let stdout: string;
      if (input.length <= 48 * 1024) {
        stdout = await execute(
          `printf '%s' '${input.toString("base64")}' | base64 -d | ${program.map(quote).join(" ")}`,
          signal,
        );
      } else {
        // Linux limits a single shell argument. Large inputs travel through the
        // file API inside an exclusively created private directory, not argv.
        directory = `/tmp/jetski-control-${crypto.randomUUID()}`;
        const path = `${directory}/request.json`;
        await execute(
          this.nativeSha256
            ? native("__control-directory", "create", directory)
            : `env -i PATH=/usr/bin:/bin python3 -I -c 'import os; os.mkdir("${directory}", 0o700)'`,
          signal,
        );
        // Direct write_file rejects decoded files above 5 MiB. A four-MiB
        // binary import becomes larger than that after its JSON/base64 envelope.
        if (input.length > 5 * 1024 * 1024) {
          await this.api.uploadFile(host, path, input, signal);
        } else {
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
            typeof uploaded.value.path !== "string" ||
            uploaded.value.path.includes("\0") ||
            posix.resolve("/home/user", uploaded.value.path) !== path ||
            uploaded.value.size !== input.length
          )
            throw Error("Invalid control upload receipt");
        }
        const digest = createHash("sha256").update(input).digest("hex");
        stdout = await execute(
          this.nativeSha256
            ? native("__control-file", directory, String(input.length), digest)
            : `env -i PATH=/usr/bin:/bin python3 -I -c 'import hashlib,os,subprocess,sys; f=os.open("${path}",os.O_RDONLY|os.O_NOFOLLOW); data=os.fdopen(f,"rb").read(${inputLimit + 1}); assert len(data)==${input.length} and hashlib.sha256(data).hexdigest()=="${digest}"; sys.exit(subprocess.run(${JSON.stringify(program)},input=data,env={"PATH":"/usr/bin:/bin"}).returncode)'`,
          signal,
        );
      }

      return stdout;
    } catch (error) {
      if (error instanceof HostTransportError) throw error;
      throw new HostTransportError(
        "Boat host command failed; remote completion unknown",
        { provider: "boat", code: signal?.aborted ? "aborted" : "transport" },
      );
    } finally {
      if (directory) {
        try {
          // A fresh unguessable directory belongs only to this invocation. Never
          // recursively delete it; unexpected contents must make cleanup fail.
          await execute(
            this.nativeSha256
              ? native("__control-directory", "close", directory)
              : `env -i PATH=/usr/bin:/bin python3 -I -c 'import os,stat; f=os.open("${directory}",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW); s=os.fstat(f); assert s.st_uid==os.geteuid() and stat.S_IMODE(s.st_mode)==0o700; names=os.listdir(f); assert all(n=="request.json" for n in names); os.unlink("request.json",dir_fd=f) if names else None; os.close(f); os.rmdir("${directory}")'`,
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
