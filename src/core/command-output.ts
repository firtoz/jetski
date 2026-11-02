import type {
  CheckpointRegistry,
  CheckpointRoot,
  StreamPart,
} from "./checkpoints.js";
import {
  type CheckpointStore,
  canonical,
  DEFAULTS,
  type Fence,
  type Json,
  type ObjectInfo,
} from "./contracts.js";

export const OUTPUT_LIMIT = DEFAULTS.outputChannelBytes;
export const OUTPUT_CHUNK = DEFAULTS.outputChunkBytes;
export const OUTPUT_CHANNELS = ["stdout", "stderr"] as const;
export type OutputChannel = (typeof OUTPUT_CHANNELS)[number];
export type OutputSegment = {
  base64: string;
  nextOffset: number;
  terminal: boolean;
};
type OutputMetadata = {
  kind: "command-output";
  version: 1;
  commandId: string;
  status: Json;
  channels: Record<OutputChannel, number[]>;
};
export function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let at = 0; at < bytes.length; at += 8192)
    parts.push(String.fromCharCode(...bytes.subarray(at, at + 8192)));
  return btoa(parts.join(""));
}
export function decodeBase64(
  value: string,
  maximumBytes = OUTPUT_CHUNK,
): Uint8Array {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > DEFAULTS.maxObjectBytes
  )
    throw new Error("Invalid binary segment bound");
  if (value.length > Math.ceil(maximumBytes / 3) * 4)
    throw new Error("Encoded segment exceeds bound");
  const decoded = Uint8Array.from(atob(value), (character) =>
    character.charCodeAt(0),
  );
  if (decoded.length > maximumBytes || encodeBase64(decoded) !== value)
    throw new Error("Invalid binary segment");
  return decoded;
}
async function sha(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
export function validateOutputRoot(
  root: CheckpointRoot,
  id?: string,
): OutputMetadata {
  const value = root.metadata as OutputMetadata | null;
  if (
    !value ||
    value.kind !== "command-output" ||
    value.version !== 1 ||
    (id !== undefined && value.commandId !== id) ||
    typeof value.commandId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value.commandId,
    ) ||
    Object.keys(value).sort().join(",") !==
      "channels,commandId,kind,status,version" ||
    !value.status ||
    typeof value.status !== "object" ||
    Array.isArray(value.status) ||
    value.status.id !== value.commandId ||
    !["succeeded", "failed", "cancelled"].includes(
      String(value.status.phase),
    ) ||
    !value.channels ||
    Object.keys(value.channels).sort().join(",") !== "stderr,stdout"
  )
    throw new Error("Invalid command output root");
  for (const channel of OUTPUT_CHANNELS)
    if (
      !Array.isArray(value.channels[channel]) ||
      value.channels[channel].length > 64 ||
      value.channels[channel].some(
        (index) =>
          !Number.isInteger(index) || index < 0 || index >= root.frames.length,
      )
    )
      throw new Error("Invalid output frame index");
  const indices = OUTPUT_CHANNELS.flatMap((channel) => value.channels[channel]);
  if (
    indices.length !== root.frames.length ||
    indices.some((index, position) => index !== position)
  )
    throw Error("Incomplete or reordered output frames");
  for (const channel of OUTPUT_CHANNELS) {
    let total = 0;
    for (const index of value.channels[channel]) {
      const frame = root.frames[index]!;
      if (
        !frame ||
        !Number.isSafeInteger(frame.bytes) ||
        frame.bytes < 1 ||
        frame.bytes > OUTPUT_CHUNK
      )
        throw Error("Invalid output frame extent");
      total += frame.bytes;
    }
    if (total > OUTPUT_LIMIT)
      throw Error("Output channel extent exceeds bound");
  }
  return value;
}
export class CommandOutputStore {
  constructor(
    private readonly objects: CheckpointStore,
    private readonly registry: CheckpointRegistry,
  ) {}
  private rootId(id: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
    )
      throw new Error("Invalid command ID");
    return `command-${id}`;
  }
  async retained(fence: Fence, id: string): Promise<Json | undefined> {
    const root = await this.registry.root(fence, this.rootId(id));
    return root ? validateOutputRoot(root, id).status : undefined;
  }
  async retain(
    fence: Fence,
    id: string,
    status: Json,
    read: (
      channel: OutputChannel,
      offset: number,
      bytes: number,
    ) => Promise<Json>,
    beforeUpload?: () => void,
  ): Promise<void> {
    const rootId = this.rootId(id),
      prior = await this.registry.root(fence, rootId);
    if (prior) {
      if (canonical(validateOutputRoot(prior, id).status) !== canonical(status))
        throw new Error("Command outcome identity conflict");
      return;
    }
    if (
      !status ||
      typeof status !== "object" ||
      Array.isArray(status) ||
      status.id !== id ||
      !["succeeded", "failed", "cancelled"].includes(String(status.phase))
    )
      throw new Error("Command outcome unresolved");
    const parts = await this.registry.beginStreamSave(fence, rootId, {
      commandId: id,
      status,
    });
    const frames: ObjectInfo[] = [],
      channels: Record<OutputChannel, number[]> = { stdout: [], stderr: [] };
    for (const channel of OUTPUT_CHANNELS) {
      let offset = 0;
      while (true) {
        const key = `${channel}_${offset}`;
        let part: StreamPart | undefined = parts[key];
        const verified = part?.object
          ? await this.objects.head(part.object)
          : undefined;
        const reusable =
          part &&
          (!part.object ||
            (verified?.sha256 === part.sha256 &&
              verified.bytes === part.bytes &&
              verified.owner === fence.owner &&
              verified.sandbox === fence.sandbox));
        if (!reusable) {
          const value = await read(channel, offset, OUTPUT_CHUNK);
          if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            typeof value.base64 !== "string" ||
            typeof value.terminal !== "boolean"
          )
            throw Error("Invalid command output segment");
          const bytes = decodeBase64(value.base64);
          if (
            value.nextOffset !== offset + bytes.length ||
            offset + bytes.length > OUTPUT_LIMIT ||
            (!bytes.length && !value.terminal)
          )
            throw Error("Invalid output cursor progress");
          const digest = await sha(bytes);
          const object = bytes.length
            ? {
                owner: fence.owner,
                sandbox: fence.sandbox,
                id: crypto.randomUUID(),
                bytes: bytes.length,
                sha256: digest,
              }
            : null;
          part = {
            bytes: bytes.length,
            sha256: digest,
            nextOffset: offset + bytes.length,
            terminal: value.terminal,
            object,
          };
          await this.registry.planStreamPart(fence, rootId, key, part);
          if (object) {
            beforeUpload?.();
            const stored = await this.objects.put(
              object,
              (async function* () {
                yield bytes;
              })(),
              { bytes: bytes.length, sha256: digest },
            );
            if (canonical(stored) !== canonical(object))
              throw Error("Output upload receipt mismatch");
          }
        }
        if (
          !part ||
          part.nextOffset !== offset + part.bytes ||
          part.nextOffset > OUTPUT_LIMIT
        )
          throw Error("Invalid retained output segment");
        if (part.object) {
          if (channels[channel].length >= 64) throw Error("Output frame limit");
          channels[channel].push(frames.length);
          frames.push(part.object);
        }
        offset = part.nextOffset;
        if (part.terminal) break;
      }
    }
    await this.registry.publish(fence, rootId, rootId, frames, {
      kind: "command-output",
      version: 1,
      commandId: id,
      status,
      channels,
    });
  }
  async read(
    fence: Fence,
    id: string,
    channel: OutputChannel,
    offset: number,
    count: number,
  ): Promise<OutputSegment> {
    if (
      !OUTPUT_CHANNELS.includes(channel) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > OUTPUT_CHUNK
    )
      throw new Error("Invalid output range");
    const rootId = this.rootId(id),
      reader = crypto.randomUUID();
    await this.registry.admit(fence, reader, "reader", rootId);
    try {
      const root = await this.registry.root(fence, rootId);
      if (!root) throw new Error("Output root missing");
      const indices = validateOutputRoot(root, id).channels[channel];
      const objects = indices.map((index) => {
        const object = root.frames[index];
        if (
          !object ||
          object.owner !== fence.owner ||
          object.sandbox !== fence.sandbox ||
          object.bytes > OUTPUT_CHUNK
        )
          throw new Error("Invalid output object");
        return object;
      });
      const total = objects.reduce((sum, object) => sum + object.bytes, 0);
      if (offset > total || total > OUTPUT_LIMIT)
        throw new Error("Output cursor beyond end");
      const result = new Uint8Array(Math.min(count, total - offset));
      let position = 0,
        written = 0;
      for (const object of objects) {
        const end = position + object.bytes;
        if (end > offset && position < offset + result.length) {
          const full = new Uint8Array(object.bytes);
          let filled = 0;
          for await (const bytes of this.objects.read(object)) {
            if (filled + bytes.length > full.length)
              throw new Error("Output object grew");
            full.set(bytes, filled);
            filled += bytes.length;
          }
          if (filled !== object.bytes || (await sha(full)) !== object.sha256)
            throw new Error("Output integrity failure");
          const start = Math.max(0, offset - position),
            length = Math.min(object.bytes - start, result.length - written);
          result.set(full.subarray(start, start + length), written);
          written += length;
        }
        position = end;
      }
      if (written !== result.length)
        throw new Error("Output reconstruction incomplete");
      return {
        base64: encodeBase64(result),
        nextOffset: offset + written,
        terminal: offset + written === total,
      };
    } finally {
      await this.registry.close(fence, reader);
    }
  }
}
