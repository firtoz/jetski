import assert from "node:assert/strict";
import { test } from "node:test";
import { BoatApi } from "../src/providers/boat.js";

test("authorized binary ranges are bounded, exact and never forward API credentials", async () => {
  const content = Buffer.from("immutable checkpoint bytes");
  let fault = "",
    authorizations = 0;
  const api = new BoatApi("private", async (url, init) => {
    if (String(url).startsWith("https://boat.dev/")) {
      authorizations++;
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer private",
      );
      assert.ok(String(url).endsWith("/files/download-url"));
      return Response.json({
        method: "GET",
        url: "https://data.invalid/file?signature=private",
        expiresAt: new Date(Date.now() + 900000).toISOString(),
      });
    }
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    assert.equal(init?.redirect, "manual");
    const range = new Headers(init?.headers).get("range")!;
    const m = /^bytes=(\d+)-(\d+)$/.exec(range)!;
    const start = Number(m[1]),
      end = Number(m[2]);
    const bytes = content.subarray(start, end + 1);
    if (fault === "redirect") return new Response(null, { status: 302 });
    if (fault === "ignored") return new Response(content, { status: 200 });
    return new Response(fault === "short" ? bytes.subarray(1) : bytes, {
      status: 206,
      headers: {
        "content-range": `bytes ${start}-${end}/${content.length + (fault === "range" ? 1 : 0)}`,
      },
    });
  });
  const download = await api.openDownload(
    "bx_owned",
    "/tmp/jetski-checkpoint-exports/capture/archive.tgz",
    content.length,
  );
  assert.deepEqual(
    Buffer.from(await download.read(2, 5)),
    content.subarray(2, 7),
  );
  assert.equal(authorizations, 1);
  for (fault of ["redirect", "ignored", "short", "range"])
    await assert.rejects(download.read(2, 5));
  await assert.rejects(download.read(0, 9 * 1024 * 1024));
});

test("checkpoint binding keeps small deltas on control and shares a single binary authorization", async (t) => {
  const { SqliteState } = await import("../src/state/sqlite.js");
  const { BoatTransport } = await import("../src/transport/boat.js");
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  await state.transaction((tx) => {
    tx.put("boat-host/bx_owned", "owned");
    tx.put("owned", { id: "bx_owned", retired: false });
  });
  const bytes = Buffer.alloc(1024 * 1024, 17),
    lease = {
      owner: "owner",
      poolId: "pool",
      slotId: "slot",
      machineId: "bx_owned",
      sandboxId: "box",
      assignmentId: "capture",
      generation: 1,
    };
  const archive = {
    version: 1 as const,
    sha256: "a".repeat(64),
    bytes: bytes.length,
    expandedBytes: 1,
    entries: 2,
    frames: [
      {
        offset: 0,
        bytes: bytes.length,
        sha256: "a".repeat(64),
        expandedBytes: 1,
        expandedSha256: "b".repeat(64),
      },
    ],
  };
  let exports = 0,
    authorizations = 0,
    closes = 0,
    controlReads = 0;
  const api = new BoatApi("private", async (url, init) => {
    if (String(url).startsWith("https://data.invalid/")) {
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      const m = /bytes=(\d+)-(\d+)/.exec(
        new Headers(init?.headers).get("range")!,
      )!;
      const start = Number(m[1]),
        end = Number(m[2]);
      return new Response(bytes.subarray(start, end + 1), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/${bytes.length}` },
      });
    }
    const body = JSON.parse(init?.body as string);
    if (String(url).endsWith("download-url")) {
      authorizations++;
      return Response.json({
        method: "GET",
        url: "https://data.invalid/archive?signature=private",
        expiresAt: new Date(Date.now() + 900000).toISOString(),
      });
    }
    const encoded = /printf '%s' '([A-Za-z0-9+/=]+)'/.exec(body.command)![1]!;
    const request = JSON.parse(Buffer.from(encoded, "base64").toString());
    assert.equal(
      request.payload.image,
      "example/linux@sha256:" + "a".repeat(64),
    );
    let result;
    if (request.action === "checkpoint-source") {
      exports++;
      result = {
        path: "/tmp/jetski-checkpoint-exports/capture/archive.tgz",
        sha256: archive.sha256,
        bytes: bytes.length,
      };
    } else if (request.action === "checkpoint-source-close") {
      closes++;
      result = { closed: true };
    } else {
      assert.equal(request.action, "read-checkpoint");
      controlReads++;
      const { offset, bytes: count } = request.payload;
      result = {
        offset,
        bytes: count,
        base64: bytes.subarray(offset, offset + count).toString("base64"),
      };
    }
    return Response.json({
      success: true,
      exitCode: 0,
      timedOut: false,
      stderr: "",
      stdout: JSON.stringify({ version: 1, id: request.id, result }),
    });
  });
  const transport = new BoatTransport(state, api, 300, { archiveReads: true });
  assert.ok(transport.checkpointSource);
  const source = await transport.checkpointSource(
    "bx_owned",
    lease,
    archive,
    "example/linux@sha256:" + "a".repeat(64),
  );
  assert.ok(source);
  assert.equal(exports, 0);
  assert.deepEqual(
    Buffer.from(await source.read(0, 64)),
    bytes.subarray(0, 64),
  );
  assert.equal(controlReads, 1);
  assert.equal(exports, 0);
  await Promise.all([
    source.read(0, 512 * 1024),
    source.read(512 * 1024, 512 * 1024),
  ]);
  assert.equal(exports, 1);
  assert.equal(authorizations, 1);
  await source.close?.();
  assert.equal(closes, 1);
});
