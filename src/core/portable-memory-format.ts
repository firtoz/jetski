import {
  canonical,
  identifier,
  type ObjectInfo,
  type Scope,
} from "./contracts.js";

/** Limits are format acceptance bounds, independent of capture tuning. */
export const PORTABLE_MEMORY_FORMAT = Object.freeze({
  version: 1,
  maxManifestBytes: 4 * 1024 ** 2,
  maxFiles: 256,
  maxChunks: 8192,
  maxBytes: 8 * 1024 ** 3,
  maxChunkBytes: 4 * 1024 ** 2,
  maxStoredChunkBytes: 8 * 1024 ** 2,
  maxCpuFeatures: 512,
});
export const MEMORY_CHUNK_CODECS = ["identity", "gzip"] as const;
export type MemoryChunkCodec = (typeof MEMORY_CHUNK_CODECS)[number];
export type PortableMemoryChunk = {
  offset: number;
  bytes: number;
  sha256: string;
  codec: MemoryChunkCodec;
  object: ObjectInfo;
};
export type PortableMemoryFile = {
  path: string;
  bytes: number;
  sha256: string;
  chunks: PortableMemoryChunk[];
};
export type PortableMemoryCompatibility = {
  runtimeSha256: string;
  hostAbiSha256: string;
  image: string;
  configurationSha256: string;
  platform: "systrap";
  kernelVersion: string;
  /** Features actually exposed to the sandbox, not the source host's full set. */
  cpuFeatures: string[];
};
export type PortableMemoryManifest = Scope & {
  kind: "portable-memory";
  version: 1;
  checkpointId: string;
  generation: number;
  filesystemSha256: string;
  compatibility: PortableMemoryCompatibility;
  directories: string[];
  files: PortableMemoryFile[];
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function fields(
  value: unknown,
  names: string,
): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).sort().join(",") !== names)
    throw Error("Invalid portable memory fields");
}
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= min &&
  value <= max;
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Parse metadata only: success does not establish publication, byte integrity,
 * filesystem equivalence or permission to execute. Callers must prove those
 * independently before native restore. The result is detached from input data. */
export function parsePortableMemory(
  value: unknown,
  scope: Scope,
): PortableMemoryManifest {
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
    PORTABLE_MEMORY_FORMAT.maxManifestBytes
  )
    throw Error("Portable memory manifest exceeds byte bound");
  identifier(scope.owner);
  identifier(scope.sandbox);
  fields(
    value,
    "checkpointId,compatibility,directories,files,filesystemSha256,generation,kind,owner,sandbox,version",
  );
  if (
    value.kind !== "portable-memory" ||
    value.version !== 1 ||
    value.owner !== scope.owner ||
    value.sandbox !== scope.sandbox ||
    typeof value.checkpointId !== "string" ||
    !hash(value.filesystemSha256) ||
    !integer(value.generation, 1, Number.MAX_SAFE_INTEGER)
  )
    throw Error("Invalid portable memory binding");
  identifier(value.checkpointId);
  const compatibility = value.compatibility;
  fields(
    compatibility,
    "configurationSha256,cpuFeatures,hostAbiSha256,image,kernelVersion,platform,runtimeSha256",
  );
  if (
    !hash(compatibility.runtimeSha256) ||
    !hash(compatibility.hostAbiSha256) ||
    !hash(compatibility.configurationSha256) ||
    typeof compatibility.image !== "string" ||
    compatibility.image.length > 1024 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(
      compatibility.image,
    ) ||
    compatibility.platform !== "systrap" ||
    typeof compatibility.kernelVersion !== "string" ||
    !/^[\x21-\x7e]{1,256}$/.test(compatibility.kernelVersion) ||
    !Array.isArray(compatibility.cpuFeatures) ||
    compatibility.cpuFeatures.length < 1 ||
    compatibility.cpuFeatures.length > PORTABLE_MEMORY_FORMAT.maxCpuFeatures
  )
    throw Error("Invalid portable memory compatibility");
  let previous = "";
  for (const feature of compatibility.cpuFeatures) {
    if (
      typeof feature !== "string" ||
      !/^[a-zA-Z0-9_]{1,64}$/.test(feature) ||
      feature <= previous
    )
      throw Error("Noncanonical portable CPU features");
    previous = feature;
  }
  if (
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > PORTABLE_MEMORY_FORMAT.maxFiles
  )
    throw Error("Invalid portable memory file count");
  const paths = new Set<string>(),
    objects = new Map<string, string>();
  let total = 0,
    chunks = 0;
  previous = "";
  for (const file of value.files) {
    fields(file, "bytes,chunks,path,sha256");
    if (
      typeof file.path !== "string" ||
      file.path.length > 1024 ||
      file.path <= previous ||
      file.path.includes("\\") ||
      file.path.includes("\0") ||
      file.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      !integer(file.bytes, 0, PORTABLE_MEMORY_FORMAT.maxBytes) ||
      !hash(file.sha256) ||
      !Array.isArray(file.chunks) ||
      file.chunks.length > PORTABLE_MEMORY_FORMAT.maxChunks
    )
      throw Error("Invalid portable memory file");
    paths.add(file.path);
    previous = file.path;
    total += file.bytes;
    if (total > PORTABLE_MEMORY_FORMAT.maxBytes)
      throw Error("Portable memory exceeds byte limit");
    if (!file.bytes && file.sha256 !== EMPTY_SHA256)
      throw Error("Invalid empty memory file");
    let offset = 0;
    for (const chunk of file.chunks) {
      fields(chunk, "bytes,codec,object,offset,sha256");
      if (
        ++chunks > PORTABLE_MEMORY_FORMAT.maxChunks ||
        chunk.offset !== offset ||
        !integer(chunk.bytes, 1, PORTABLE_MEMORY_FORMAT.maxChunkBytes) ||
        !hash(chunk.sha256) ||
        !MEMORY_CHUNK_CODECS.includes(chunk.codec as MemoryChunkCodec)
      )
        throw Error("Invalid portable memory chunk");
      const object = chunk.object;
      fields(object, "bytes,id,owner,sandbox,sha256");
      if (
        object.owner !== scope.owner ||
        object.sandbox !== scope.sandbox ||
        typeof object.id !== "string" ||
        !hash(object.sha256) ||
        !integer(object.bytes, 1, PORTABLE_MEMORY_FORMAT.maxStoredChunkBytes)
      )
        throw Error("Invalid portable memory object");
      identifier(object.id);
      if (
        chunk.codec === "identity" &&
        (object.bytes !== chunk.bytes || object.sha256 !== chunk.sha256)
      )
        throw Error("Identity chunk byte mismatch");
      const identity = canonical({
        object: {
          owner: scope.owner,
          sandbox: scope.sandbox,
          id: object.id,
          bytes: object.bytes,
          sha256: object.sha256,
        },
        bytes: chunk.bytes,
        sha256: chunk.sha256,
        codec: chunk.codec as MemoryChunkCodec,
      });
      const prior = objects.get(object.id);
      if (prior && prior !== identity)
        throw Error("Conflicting portable memory object");
      objects.set(object.id, identity);
      offset += chunk.bytes;
    }
    if (offset !== file.bytes) throw Error("Portable memory extent mismatch");
  }
  if (
    !Array.isArray(value.directories) ||
    value.directories.length + value.files.length >
      PORTABLE_MEMORY_FORMAT.maxFiles
  )
    throw Error("Invalid portable memory directories");
  previous = "";
  const directories = new Set<string>();
  for (const path of value.directories) {
    if (
      typeof path !== "string" ||
      path <= previous ||
      path.length > 1024 ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      paths.has(path)
    )
      throw Error("Invalid portable memory directory");
    directories.add(path);
    previous = path;
  }
  for (const path of [...paths, ...directories]) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join("/");
      if (paths.has(parent) || !directories.has(parent))
        throw Error("Portable memory path conflict");
    }
  }
  if (!total) throw Error("Empty portable memory image");
  return JSON.parse(JSON.stringify(value)) as PortableMemoryManifest;
}

/** Complete physical reachability, including chunks reused from older saves.
 * No base checkpoint is required to reconstruct the returned manifest. */
export function portableMemoryObjects(
  manifest: PortableMemoryManifest,
): ObjectInfo[] {
  const checked = parsePortableMemory(manifest, manifest);
  const objects = new Map<string, ObjectInfo>();
  for (const file of checked.files)
    for (const chunk of file.chunks) objects.set(chunk.object.id, chunk.object);
  return [...objects.values()];
}
