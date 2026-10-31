import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { persistentPath } from "../src/core/files.js";
import { JetskiClient } from "../src/sdk.js";

test("file paths stay inside declared roots", () => {
  for (const path of ["/workspace", "/workspace/雪..bin", "/home/sandbox/file"])
    assert.equal(persistentPath(path), path);
  for (const path of [
    "/etc/passwd",
    "/workspace/../x",
    "/workspace//x",
    "/workspace/",
    "/home/sandboxish",
    "/workspace/a\0b",
  ])
    assert.throws(() => persistentPath(path));
});

test("SDK file stream verifies every chunk and version with bounded cursor progress", async () => {
  const bytes = Buffer.from([0, 255, 10, 1]);
  let calls = 0;
  let corrupt = false;
  let changed = false;
  const client = new JetskiClient("http://127.0.0.1", "token", async (url) => {
    calls++;
    const query = new URL(String(url)).searchParams;
    const offset = Number(query.get("offset"));
    if (offset) assert.equal(query.get("version"), "a".repeat(64));
    const part = bytes.subarray(offset, offset + 2);
    return Response.json({
      base64: part.toString("base64"),
      offset,
      nextOffset: offset + part.length,
      size: bytes.length,
      version: (changed && offset ? "b" : "a").repeat(64),
      eof: offset + part.length === bytes.length,
      sha256: corrupt
        ? "wrong"
        : createHash("sha256").update(part).digest("hex"),
    });
  });
  const read = async () => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of client.readFileStream(
      "sandbox",
      "/workspace/a..bin",
    ))
      chunks.push(chunk);
    return Buffer.concat(chunks);
  };
  assert.deepEqual(await read(), bytes);
  assert.equal(calls, 2);
  corrupt = true;
  await assert.rejects(read(), /Invalid or changed/);
  corrupt = false;
  changed = true;
  await assert.rejects(read(), /Invalid or changed/);
});
