import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type PortableMemoryManifest,
  parsePortableMemory,
  portableMemoryObjects,
} from "../src/core/portable-memory-format.js";

const scope = { owner: "owner", sandbox: "sandbox" };
const digest = "a".repeat(64);
const manifest = (): PortableMemoryManifest => ({
  ...scope,
  kind: "portable-memory",
  version: 1,
  checkpointId: "checkpoint",
  generation: 2,
  filesystemSha256: digest,
  compatibility: {
    runtimeSha256: digest,
    hostAbiSha256: digest,
    image: "example/linux@sha256:" + digest,
    configurationSha256: digest,
    platform: "systrap",
    kernelVersion: "6.14.0",
    cpuFeatures: ["sse", "sse2"],
  },
  directories: ["state"],
  files: [
    {
      path: "state/pages.img",
      bytes: 8,
      sha256: digest,
      chunks: [0, 4].map((offset) => ({
        offset,
        bytes: 4,
        sha256: digest,
        codec: "identity",
        object: { ...scope, id: "chunk", bytes: 4, sha256: digest },
      })),
    },
  ],
});
test("portable manifests are detached and enumerate repeated immutable chunks once", () => {
  const input = manifest(),
    parsed = parsePortableMemory(input, scope);
  assert.equal(portableMemoryObjects(parsed).length, 1);
  input.files[0]!.chunks[0]!.object.owner = "other";
  assert.equal(parsed.files[0]!.chunks[0]!.object.owner, scope.owner);
});
for (const [name, mutate] of Object.entries<
  (value: PortableMemoryManifest) => void
>({
  "scope substitution": (v) => {
    v.owner = "other";
  },
  "object scope substitution": (v) => {
    v.files[0]!.chunks[0]!.object.sandbox = "other";
  },
  gap: (v) => {
    v.files[0]!.chunks[1]!.offset = 5;
  },
  "truncated file": (v) => {
    v.files[0]!.bytes = 9;
  },
  "conflicting object": (v) => {
    v.files[0]!.chunks[1]!.object.sha256 = "b".repeat(64);
    v.files[0]!.chunks[1]!.sha256 = "b".repeat(64);
  },
  "codec mismatch": (v) => {
    v.files[0]!.chunks[0]!.object.bytes = 3;
  },
  traversal: (v) => {
    v.files[0]!.path = "../pages.img";
  },
  "missing directory": (v) => {
    v.directories = [];
  },
  "file-directory collision": (v) => {
    v.directories.push("state/pages.img");
  },
  "duplicate files": (v) => {
    v.files.push(structuredClone(v.files[0]!));
  },
  "ambiguous CPU features": (v) => {
    v.compatibility.cpuFeatures = ["sse2", "sse"];
  },
  "unbounded chunk": (v) => {
    v.files[0]!.chunks[0]!.bytes = 8 * 1024 ** 3;
  },
  "unknown future format": (v) => {
    Object.assign(v, { version: 2 });
  },
  "unknown fields": (v) => {
    Object.assign(v, { baseCheckpoint: "hidden-dependency" });
  },
}))
  test(`portable manifests reject ${name}`, () =>
    assert.throws(() => {
      const value = manifest();
      mutate(value);
      parsePortableMemory(value, scope);
    }));
