import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { S3Client } from "@aws-sdk/client-s3";
import {
  CheckpointRegistry,
  CheckpointTransfer,
  DEFAULTS,
} from "../src/core/index.js";
import { SqliteState } from "../src/state/sqlite.js";
import { S3CheckpointStore } from "../src/storage/s3.js";
import { qualifyStorage } from "../src/testing/storage.js";

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

test("S3 wire contract: immutable reservation, loss, ranges, pagination and corruption", async (t) => {
  const objects = new Map<
    string,
    { bytes: Buffer; metadata: Record<string, string> }
  >();
  let loseReservation = false;
  let losePut = false,
    corruptGet = false,
    badPage = "",
    missingBucket = false;
  const requests: Array<{
    method: string;
    path: string;
    conditional: string | undefined;
  }> = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost"),
      path = decodeURIComponent(url.pathname);
    requests.push({
      method: request.method!,
      path,
      conditional: request.headers["if-none-match"] as string | undefined,
    });
    const error = (code: string, status: number) => {
      response.writeHead(status, { "content-type": "application/xml" });
      response.end(
        `<Error><Code>${code}</Code><Message>fixture</Message></Error>`,
      );
    };
    if (missingBucket) return error("NoSuchBucket", 404);
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      if (objects.has(path) && request.headers["if-none-match"] === "*")
        return error("PreconditionFailed", 412);
      const metadata: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers))
        if (key.startsWith("x-amz-meta-") && typeof value === "string")
          metadata[key.slice(11)] = value;
      objects.set(path, { bytes: Buffer.concat(chunks), metadata });
      if (loseReservation && path.includes("/reservations/")) {
        loseReservation = false;
        response.destroy();
        return;
      }
      if (losePut && path.includes("/objects/")) {
        losePut = false;
        response.destroy();
        return;
      }
      response.writeHead(200, { etag: '"fixture"' });
      response.end();
      return;
    }
    if (request.method === "DELETE") {
      objects.delete(path);
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix")!;
      const start = Number(url.searchParams.get("continuation-token") ?? 0);
      const keys = [...objects.keys()]
        .map((key) => key.slice("/bucket/".length))
        .filter((key) => key.startsWith(prefix))
        .sort();
      const selected = keys.slice(start, start + 1);
      const more = start + selected.length < keys.length;
      const entries = selected
        .map(
          (key) =>
            `<Contents><Key>${badPage === "foreign" ? "outside/key" : key}</Key><Size>${objects.get(`/bucket/${key}`)!.bytes.length}</Size></Contents>`,
        )
        .join("");
      const token =
        badPage === "missing-token"
          ? ""
          : `<NextContinuationToken>${start + selected.length}</NextContinuationToken>`;
      response.writeHead(200, { "content-type": "application/xml" });
      response.end(
        `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>bucket</Name><Prefix>${prefix}</Prefix><KeyCount>${selected.length}</KeyCount><IsTruncated>${more}</IsTruncated>${more ? token : ""}${entries}</ListBucketResult>`,
      );
      return;
    }
    const object = objects.get(path);
    if (!object) return error("NoSuchKey", 404);
    const body = Buffer.from(object.bytes);
    if (corruptGet && body.length) body[0] = body[0]! ^ 1;
    const headers: Record<string, string | number> = {
      "content-length": body.length,
    };
    for (const [key, value] of Object.entries(object.metadata))
      headers[`x-amz-meta-${key}`] = value;
    response.writeHead(200, headers);
    response.end(body);
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
  const store = new S3CheckpointStore(client, {
    bucket: "bucket",
    prefix: "test/v1",
  });
  const scope = { owner: "owner", sandbox: "box" },
    data = Buffer.from([0, 255, 1, 2]);
  const source = async function* () {
    yield data.subarray(0, 2);
    yield data.subarray(2);
  };
  const expected = { bytes: data.length, sha256: sha(data) };
  await store.put({ ...scope, id: "a" }, source(), expected);
  const chunks: Uint8Array[] = [];
  for await (const chunk of store.read(
    { ...scope, id: "a" },
    { start: 1, endExclusive: 3 },
  ))
    chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), data.subarray(1, 3));
  await assert.rejects(store.put({ ...scope, id: "a" }, source(), expected));
  await store.delete({ ...scope, id: "a" });
  await store.delete({ ...scope, id: "a" });
  assert.equal(await store.head({ ...scope, id: "a" }), undefined);
  await assert.rejects(store.put({ ...scope, id: "a" }, source(), expected));
  losePut = true;
  await assert.rejects(store.put({ ...scope, id: "b" }, source(), expected));
  assert.deepEqual(await store.head({ ...scope, id: "b" }), {
    ...scope,
    id: "b",
    ...expected,
  });
  await assert.rejects(store.put({ ...scope, id: "b" }, source(), expected));
  await store.put({ ...scope, id: "c" }, source(), expected);
  loseReservation = true;
  await assert.rejects(
    store.put({ ...scope, id: "reservation-loss" }, source(), expected),
  );
  assert.equal(
    await store.head({ ...scope, id: "reservation-loss" }),
    undefined,
  );
  await assert.rejects(
    store.put({ ...scope, id: "reservation-loss" }, source(), expected),
  );
  const concurrent = await Promise.allSettled([
    store.put({ ...scope, id: "race" }, source(), expected),
    store.put({ ...scope, id: "race" }, source(), expected),
  ]);
  assert.equal(
    concurrent.filter((result) => result.status === "fulfilled").length,
    1,
  );
  await store.delete({ ...scope, id: "race" });
  await store.put(
    { ...scope, owner: "other", id: "foreign" },
    source(),
    expected,
  );
  const list = async () => {
    const values = [];
    for await (const value of store.list(scope)) values.push(value.id);
    return values;
  };
  assert.deepEqual(await list(), ["b", "c"]);
  badPage = "missing-token";
  await assert.rejects(list(), /continuation/);
  badPage = "foreign";
  await assert.rejects(list(), /foreign/);
  badPage = "";
  corruptGet = true;
  await assert.rejects(store.head({ ...scope, id: "b" }), /integrity/);
  await assert.rejects(list(), /integrity/);
  corruptGet = false;
  missingBucket = true;
  await assert.rejects(store.head({ ...scope, id: "b" }), /fixture/);
  missingBucket = false;
  await assert.rejects(
    store.put({ ...scope, id: "bad" }, source(), {
      ...expected,
      sha256: "0".repeat(64),
    }),
    /integrity/,
  );
  assert.equal(await store.head({ ...scope, id: "bad" }), undefined);
  await assert.rejects(store.put({ ...scope, id: "bad" }, source(), expected));
  assert.ok(
    requests
      .filter((request) => request.method === "PUT")
      .every((request) => request.conditional === "*"),
  );
  assert.ok(objects.has("/bucket/test/v1/owner/box/reservations/a"));
  assert.ok(objects.has("/bucket/test/v1/other/box/objects/foreign"));
  const qualification = await qualifyStorage(async () => {
    const fresh = new S3Client({
      endpoint: `http://127.0.0.1:${address.port}`,
      region: "auto",
      forcePathStyle: true,
      maxAttempts: 1,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    });
    return {
      store: new S3CheckpointStore(fresh, {
        bucket: "bucket",
        prefix: "test/v1",
        listPageSize: 1,
      }),
      close: () => fresh.destroy(),
    };
  });
  assert.equal(qualification.passed, true);
  assert.equal(qualification.cleanup.complete, true);
  assert.equal(qualification.checks.length, 12);

  await t.test(
    "checkpoint publication survives lost wire ACK and SQLite reopen",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "jetski-s3-recovery-"));
      let state = new SqliteState(join(dir, "state.sqlite"));
      let now = 1000;
      const fence = { owner: "recovery", sandbox: "fixture", generation: 1 };
      let registry = new CheckpointRegistry(state, store, () => now);
      const raw = Buffer.from([0, 255, 128, 10, 0]);
      const compressed = gzipSync(raw);
      const manifest = {
        version: 1,
        sha256: sha(compressed),
        bytes: compressed.length,
        expandedBytes: raw.length,
        entries: 2,
        frames: [
          {
            offset: 0,
            bytes: compressed.length,
            expandedBytes: raw.length,
            sha256: sha(compressed),
            expandedSha256: sha(raw),
          },
        ],
      };
      try {
        await registry.initialize(fence);
        losePut = true;
        await assert.rejects(
          new CheckpointTransfer(store, registry).save(
            fence,
            "first",
            manifest,
            {
              read: async (offset, count) =>
                compressed.subarray(offset, offset + count),
            },
          ),
        );
        assert.equal(await registry.root(fence, "first"), undefined);
        await assert.rejects(registry.collect(fence, "blocked"), /Active/);
        const uploadCount = () =>
          requests.filter(
            (r) =>
              r.method === "PUT" &&
              r.path.includes("/recovery/fixture/objects/"),
          ).length;
        assert.equal(uploadCount(), 1);
        state.close();
        state = new SqliteState(join(dir, "state.sqlite"));
        registry = new CheckpointRegistry(state, store, () => now);
        const absentSource = {
          read: async (): Promise<Uint8Array> => {
            throw Error("source removed");
          },
        };
        const first = await new CheckpointTransfer(store, registry).save(
          fence,
          "first",
          manifest,
          absentSource,
        );
        assert.equal(first.uploadedBytes, 0);
        assert.equal(first.reusedBytes, compressed.length);
        assert.equal(
          uploadCount(),
          1,
          "lost acknowledgement must not resend committed frame",
        );
        const second = await new CheckpointTransfer(store, registry).save(
          fence,
          "second",
          manifest,
          absentSource,
          "first",
        );
        assert.deepEqual(second.root.frames, first.root.frames);
        assert.equal(second.uploadedBytes, 0);
        await registry.retire(fence, "first");
        now += DEFAULTS.gcGraceMs;
        assert.deepEqual(await registry.collect(fence, "shared-frame"), {
          deleted: 0,
        });
        const restored: Uint8Array[] = [];
        for (const frame of second.root.frames)
          for await (const chunk of store.read(frame)) restored.push(chunk);
        assert.deepEqual(gunzipSync(Buffer.concat(restored)), raw);
        assert.equal(sha(Buffer.concat(restored)), manifest.sha256);
        await registry.admit(fence, "reader", "reader", "second");
        await assert.rejects(
          registry.collect(fence, "reader-blocked"),
          /Active/,
        );
        await registry.close(fence, "reader");
        await registry.retire(fence, "second");
        assert.deepEqual(await registry.collect(fence, "too-early"), {
          deleted: 0,
        });
        now += DEFAULTS.gcGraceMs;
        assert.deepEqual(await registry.collect(fence, "retired-frame"), {
          deleted: 1,
        });
        assert.equal(await store.head(second.root.frames[0]!), undefined);
      } finally {
        state.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

test("standalone storage validates explicit credentials and HTTPS without network allocation", async () => {
  const { standaloneStorage } = await import("../src/server/storage.js");
  const config = {
    kind: "s3" as const,
    bucket: "bucket",
    prefix: "test/v1",
    region: "auto",
    endpoint: "https://objects.example",
    accessKeyEnv: "STORE_KEY",
    secretKeyEnv: "STORE_SECRET",
  };
  await assert.rejects(
    standaloneStorage(
      "unused",
      { ...config, endpoint: "http://objects.example" },
      {},
    ),
    /HTTPS/,
  );
  await assert.rejects(standaloneStorage("unused", config, {}), /credential/);
  const storage = await standaloneStorage("unused", config, {
    STORE_KEY: "fixture",
    STORE_SECRET: "fixture",
  });
  assert.ok(storage.store instanceof S3CheckpointStore);
  storage.close();
});
