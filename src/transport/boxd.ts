import { Readable, Writable } from "node:stream";
import type { Json } from "../core/contracts.js";
import type {
  HostConnection,
  HostStreamRequest,
  HostStreamTransport,
} from "../core/host-stream.js";
import { tcpPort } from "../core/ports.js";
import { STREAM_MAGIC } from "../core/stream-protocol.js";
import type {
  CachedResumeRequest,
  HostRequest,
  HostResponse,
  HostTransport,
} from "../core/transport.js";
import {
  HOST_CONTROL_TIMEOUT_MS,
  HOST_PROTOCOL_VERSION,
  HostTransportError,
  hostRequestByteLimit,
  hostResponseByteLimit,
} from "../core/transport.js";
import type { BoxdClient } from "../providers/boxd.js";
import { hostControlArguments } from "./host-backend.js";
import { attachHostStream } from "./host-stream.js";

/** Bounded private stdin/stdout. The SDK must be configured with maxRetries:0. */
export class BoxdControlChannel {
  constructor(
    private client: BoxdClient,
    private owned: (host: string) => Promise<unknown>,
  ) {}
  async run(
    host: string,
    program: string[],
    input: Uint8Array = new Uint8Array(),
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      inputLimit?: number;
      outputLimit?: number;
    } = {},
  ) {
    if (input.length > (options.inputLimit ?? 1024 * 1024))
      throw Error("Boxd input exceeds bound");
    options.signal?.throwIfAborted();
    await this.owned(host);
    options.signal?.throwIfAborted();
    const stream = this.client.machines.streamExec(host, {
      command: program,
      cwd: "/",
    });
    const stop = () => stream.close(),
      timer = setTimeout(stop, options.timeoutMs ?? HOST_CONTROL_TIMEOUT_MS);
    options.signal?.addEventListener("abort", stop, { once: true });
    async function collect(source: AsyncIterable<Uint8Array>, maximum: number) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of source) {
        size += chunk.length;
        if (size > maximum) throw Error("Boxd output exceeds bound");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    }
    try {
      if (options.signal?.aborted) throw options.signal.reason;
      for (let offset = 0; offset < input.length; offset += 16384)
        stream.write(input.subarray(offset, offset + 16384));
      stream.end();
      const [stdout, stderr, exitCode] = await Promise.all([
        collect(stream.stdout, options.outputLimit ?? 2 * 1024 * 1024),
        collect(stream.stderr, 256 * 1024),
        stream.wait(),
      ]);
      options.signal?.throwIfAborted();
      if (exitCode !== 0)
        throw new HostTransportError(
          "Boxd control exited without a successful receipt; completion unknown",
        );
      return { stdout, stderr };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      stream.close();
    }
  }
}
export class BoxdTransport implements HostTransport {
  constructor(private channel: BoxdControlChannel) {}
  async request(
    host: string,
    request: HostRequest,
    signal?: AbortSignal,
  ): Promise<HostResponse> {
    if (request.version !== HOST_PROTOCOL_VERSION)
      throw Error("Unsupported host protocol");
    try {
      const { stdout } = await this.channel.run(
        host,
        ["sudo", "-n", ...hostControlArguments()],
        Buffer.from(JSON.stringify(request)),
        {
          ...(signal ? { signal } : {}),
          inputLimit: hostRequestByteLimit(request.action),
          outputLimit: hostResponseByteLimit(request.action),
        },
      );
      const value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(stdout),
      ) as HostResponse;
      if (
        !value ||
        value.version !== HOST_PROTOCOL_VERSION ||
        value.id !== request.id ||
        !Object.hasOwn(value, "result")
      )
        throw Error("Invalid host response");
      return value;
    } catch {
      throw new HostTransportError(
        "Boxd host control failed; remote completion unknown",
      );
    }
  }
  async resumeCached(host: string, input: CachedResumeRequest): Promise<Json> {
    const { resources, ...checkpoint } = input;
    return (
      await this.request(host, {
        version: 1,
        id: crypto.randomUUID(),
        action: "resume-cached",
        payload: { ...checkpoint, ...resources },
      })
    ).result;
  }
}

/** Authenticated SDK duplex transport for the same fenced host stream protocol. */
export class BoxdStreamTransport implements HostStreamTransport {
  constructor(
    private client: BoxdClient,
    private owned: (
      host: string,
    ) => Promise<{ owner: string; expiresAt: number }>,
  ) {}
  async open(
    host: string,
    request: HostStreamRequest,
    signal?: AbortSignal,
  ): Promise<HostConnection> {
    if (
      request.lease.machineId !== host ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        request.streamId,
      )
    )
      throw Error("Invalid stream identity");
    tcpPort(request.port);
    signal?.throwIfAborted();
    const allocation = await this.owned(host);
    if (
      allocation.owner !== request.lease.owner ||
      allocation.expiresAt <= Date.now()
    )
      throw Error("Stream owner/lifetime mismatch");
    const body = Buffer.from(
      JSON.stringify({
        version: 1,
        id: request.streamId,
        action: "stream-open",
        payload: request,
      }),
    );
    if (body.length > 16384) throw Error("Stream header bound");
    const exec = this.client.machines.streamExec(host, {
      command: ["sudo", "-n", ...hostControlArguments()],
      cwd: "/",
    });
    const input = new Writable({
      write(chunk, _encoding, callback) {
        try {
          exec.write(chunk);
          callback();
        } catch (error) {
          callback(
            error instanceof Error ? error : Error("Stream write failed"),
          );
        }
      },
      final(callback) {
        exec.end();
        callback();
      },
    });
    const output = Readable.from(exec.stdout);
    const diagnostics = (async () => {
      let bytes = 0;
      for await (const chunk of exec.stderr) {
        bytes += chunk.length;
        if (bytes > 65536) throw Error("Stream diagnostic bound");
      }
    })();
    const closed = Promise.all([exec.wait(), diagnostics]).then(
      ([code]) => code,
    );
    void closed.catch(() => exec.close());
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    try {
      return await attachHostStream(
        {
          input,
          output,
          closed,
          terminate: () => {
            exec.close();
            input.destroy();
            output.destroy();
          },
        },
        Buffer.concat([Buffer.from(STREAM_MAGIC), length, body]),
        signal,
      );
    } catch (error) {
      exec.close();
      throw error;
    }
  }
}
