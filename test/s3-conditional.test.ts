import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import { S3CheckpointStore } from "../src/storage/s3.js";

test("conditional verification saves bytes without trusting an unverified or stale receipt", async (t) => {
  const objects = new Map<
    string,
    { bytes: Buffer; metadata: Record<string, string> }
  >();
  const requests: Array<{ key: string; conditional: string | undefined }> = [];
  let deliveredBytes = 0,
    weak = false,
    corruptResponse = false,
    force304 = false;
  let ignoreCondition = false;
  let holdConditional: (() => Promise<void>) | undefined;
  const digest = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");
  const server = createServer(async (request, response) => {
    const key = decodeURIComponent(
      new URL(request.url!, "http://localhost").pathname,
    );
    const error = (name: string, status: number) => {
      response.writeHead(status, { "content-type": "application/xml" });
      response.end(`<Error><Code>${name}</Code></Error>`);
    };
    if (request.method === "PUT") {
      if (objects.has(key)) return error("PreconditionFailed", 412);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const metadata: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers))
        if (name.startsWith("x-amz-meta-") && typeof value === "string")
          metadata[name] = value;
      objects.set(key, { bytes: Buffer.concat(chunks), metadata });
      response.writeHead(200);
      response.end();
      return;
    }
    if (request.method === "DELETE") {
      objects.delete(key);
      response.writeHead(204);
      response.end();
      return;
    }
    const conditional = request.headers["if-none-match"] as string | undefined;
    requests.push({ key, conditional });
    if (force304) {
      response.writeHead(304);
      response.end();
      return;
    }
    const object = objects.get(key);
    if (!object) return error("NoSuchKey", 404);
    const etag = `${weak ? "W/" : ""}"${digest(object.bytes)}"`;
    if (conditional === etag && !ignoreCondition) {
      await holdConditional?.();
      response.writeHead(304, { etag });
      response.end();
      return;
    }
    const bytes = Buffer.from(object.bytes);
    if (corruptResponse && bytes.length) bytes[0] = bytes[0]! ^ 1;
    deliveredBytes += bytes.length;
    response.writeHead(200, {
      ...object.metadata,
      etag,
      "content-length": bytes.length,
    });
    response.end(bytes);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${address.port}`,
    region: "auto",
    forcePathStyle: true,
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
  });
  t.after(async () => {
    client.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const options = {
    bucket: "bucket",
    prefix: "conditional/v1",
    verifiedCacheEntries: 1,
  };
  const store = new S3CheckpointStore(client, options);
  const a = { owner: "owner", sandbox: "box", id: "a" },
    b = { ...a, id: "b" };
  const bytes = Buffer.from([0, 255, 128, 3]);
  const source = async function* () {
    yield bytes;
  };
  const expected = { bytes: bytes.length, sha256: digest(bytes) };
  await store.put(a, source(), expected);
  assert.equal(
    deliveredBytes,
    4,
    "Initial publication must read back every byte",
  );
  const info = await store.head(a);
  assert.deepEqual(info, { ...a, ...expected });
  assert.equal(
    deliveredBytes,
    4,
    "Unchanged verified object should return no body",
  );
  info!.sha256 = "0".repeat(64);
  assert.equal(
    (await store.head(a))?.sha256,
    expected.sha256,
    "Caller cannot mutate cached receipt",
  );
  const restored: Uint8Array[] = [];
  for await (const part of store.read(a)) restored.push(part);
  assert.deepEqual(Buffer.concat(restored), bytes);
  assert.equal(deliveredBytes, 8, "Restore always reads and hashes bytes");
  assert.equal(requests.at(-1)?.conditional, undefined);
  ignoreCondition = true;
  const beforeIgnored = deliveredBytes;
  await store.head(a);
  assert.equal(deliveredBytes, beforeIgnored + bytes.length);
  ignoreCondition = false;
  corruptResponse = true;
  await assert.rejects(async () => {
    for await (const _ of store.read(a)) {
      /* Must fail before yielding. */
    }
  }, /integrity/);
  corruptResponse = false;
  await store.head(a);
  assert.equal(
    requests.at(-1)?.conditional,
    undefined,
    "Failed read invalidates receipt",
  );
  const key = "/bucket/conditional/v1/owner/box/objects/a";
  const object = objects.get(key)!;
  object.bytes = Buffer.from([4, 255, 128, 3]);
  await assert.rejects(
    store.head(a),
    /integrity/,
    "Changed remote object cannot reuse old verification",
  );
  object.bytes = bytes;
  await store.head(a);
  await store.put(b, source(), expected);
  await store.head(a);
  assert.equal(
    requests.at(-1)?.conditional,
    undefined,
    "Bounded cache evicts oldest receipt",
  );
  const restarted = new S3CheckpointStore(client, options);
  await restarted.head(a);
  assert.equal(
    requests.at(-1)?.conditional,
    undefined,
    "Process restart begins without trusted receipts",
  );
  weak = true;
  for await (const _ of restarted.read(a)) {
    /* Fully consume the unconditional read. */
  }
  await restarted.head(a);
  assert.equal(
    requests.at(-1)?.conditional,
    undefined,
    "Weak validators never enable reuse",
  );
  weak = false;
  await store.head(a);
  let release!: () => void;
  let observed!: () => void;
  const arrived = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  holdConditional = async () => {
    observed();
    await held;
  };
  const pending = store.head(a);
  const rejected = assert.rejects(pending, /invalidated/);
  await arrived;
  await store.delete(a);
  release();
  await rejected;
  holdConditional = undefined;
  assert.equal(await store.head(a), undefined);
  force304 = true;
  await assert.rejects(
    store.head(a),
    "Unsolicited 304 cannot establish object existence",
  );
});
