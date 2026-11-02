import assert from "node:assert/strict";
import { test } from "node:test";
import { type HostRequest, HostTransportError } from "../src/core/transport.js";
import { BoatApi } from "../src/providers/boat.js";
import { SqliteState } from "../src/state/sqlite.js";
import { BoatTransport } from "../src/transport/boat.js";

test("Boat control uses only owned hosts, encoded fixed dispatch and matching receipts", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  await state.transaction((tx) => {
    tx.put("boat-host/bx_owned", "allocation");
    tx.put("allocation", {
      owner: "owner",
      operationId: "allocate",
      expiresAt: 1000,
      key: "key",
      body: {},
      id: "bx_owned",
      retired: false,
    });
  });
  const input: HostRequest = {
    version: 1,
    id: "request",
    action: "command_start",
    payload: { command: "'$(false);\\n雪\u0000" },
  };
  let calls = 0;
  let fault = "";
  const api = new BoatApi("fixture", async (url, init) => {
    calls++;
    assert.equal(
      String(url),
      "https://boat.dev/api/v1/sandboxes/bx_owned/commands",
    );
    assert.equal(init?.redirect, "manual");
    const body = JSON.parse(init?.body as string);
    assert.deepEqual(
      { ...body, command: "omitted" },
      {
        command: "omitted",
        timeoutSeconds: 300,
        detached: false,
        stream: false,
      },
    );
    const match =
      /^printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| 'sudo' '-n' 'env' '-i' 'PATH=\/usr\/bin:\/bin' 'python3' '-I' '\/opt\/jetski\/host\/control.py'$/.exec(
        body.command,
      );
    assert.ok(match);
    assert.deepEqual(
      JSON.parse(Buffer.from(match[1]!, "base64").toString("utf8")),
      input,
    );
    if (fault === "lost") throw Error("response lost");
    if (fault === "abort") {
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener(
          "abort",
          () => reject(Error("aborted")),
          { once: true },
        ),
      );
    }
    return Response.json({
      success: true,
      exitCode: fault === "exit" ? 1 : 0,
      timedOut: false,
      stdoutTruncated: fault === "truncated",
      stderr: "",
      stdout: JSON.stringify({
        version: 1,
        id: fault === "mismatch" ? "other" : input.id,
        result: { accepted: true },
      }),
    });
  });
  const transport = new BoatTransport(state, api);
  await assert.rejects(
    transport.request("bx_foreign", input),
    /not actively owned/,
  );
  assert.equal(calls, 0);
  assert.deepEqual((await transport.request("bx_owned", input)).result, {
    accepted: true,
  });
  for (const failure of ["lost", "exit", "truncated", "mismatch"]) {
    fault = failure;
    const before: number = calls;
    await assert.rejects(
      transport.request("bx_owned", input),
      (error) => error instanceof HostTransportError && error.uncertain,
    );
    assert.equal(
      calls,
      before + 1,
      "uncertain effects must never be retried by the transport",
    );
  }
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const beforeAbort = calls;
  await assert.rejects(
    transport.request("bx_owned", input, alreadyAborted.signal),
  );
  assert.equal(calls, beforeAbort);
  fault = "abort";
  const controller = new AbortController();
  const request = transport.request("bx_owned", input, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(request, HostTransportError);
  await state.transaction((tx) =>
    tx.put("allocation", { id: "bx_owned", retired: true }),
  );
  await assert.rejects(
    transport.request("bx_owned", input),
    /not actively owned/,
  );
});

test("large Boat control inputs use private file transfer and verified short commands", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  await state.transaction((tx) => {
    tx.put("boat-host/bx_owned", "allocation");
    tx.put("allocation", { id: "bx_owned", retired: false });
  });
  const input: HostRequest = {
    version: 1,
    id: "large",
    action: "import-chunk",
    payload: "b".repeat(1024 * 1024),
  };
  let uploadedPath = "",
    uploadedBytes = Buffer.alloc(0),
    cleanup = false,
    dispatch = false,
    badReceipt = false,
    wrongPath = false;
  const api = new BoatApi("fixture", async (url, init) => {
    const body = JSON.parse(init?.body as string);
    if (String(url).endsWith("/files")) {
      assert.equal(init?.method, "PUT");
      assert.match(
        body.path,
        /^\/tmp\/jetski-control-[0-9a-f-]{36}\/request.json$/,
      );
      uploadedPath = body.path;
      uploadedBytes = Buffer.from(body.content, "base64");
      assert.deepEqual(JSON.parse(uploadedBytes.toString()), input);
      return Response.json({
        success: true,
        path: wrongPath
          ? "../../tmp/foreign/request.json"
          : `../..${uploadedPath}`,
        size: badReceipt ? 0 : uploadedBytes.length,
      });
    }
    assert.ok(
      Buffer.byteLength(body.command) < 4096,
      "never place large input in argv",
    );
    if (body.command.includes("hashlib")) {
      dispatch = true;
      assert.ok(body.command.includes(uploadedPath));
      assert.ok(body.command.includes(`len(data)==${uploadedBytes.length}`));
      assert.ok(body.command.includes("sha256(data).hexdigest()"));
    }
    if (body.command.includes("os.rmdir")) {
      cleanup = true;
      assert.ok(body.command.includes("os.O_NOFOLLOW"));
      assert.ok(body.command.includes("dir_fd=f"));
    }
    return Response.json({
      success: true,
      exitCode: 0,
      timedOut: false,
      stderr: "",
      stdout: JSON.stringify({ version: 1, id: input.id, result: true }),
    });
  });
  const transport = new BoatTransport(state, api);
  await assert.rejects(
    transport.request("bx_owned", { ...input, action: "create" }),
    /too large/,
  );
  await assert.rejects(
    transport.request("bx_owned", {
      ...input,
      payload: "x".repeat(6 * 1024 * 1024),
    }),
    /too large/,
  );
  assert.equal((await transport.request("bx_owned", input)).result, true);
  assert.equal(dispatch, true);
  assert.equal(cleanup, true);
  wrongPath = true;
  dispatch = false;
  await assert.rejects(
    transport.request("bx_owned", input),
    HostTransportError,
  );
  assert.equal(dispatch, false);
  wrongPath = false;
  badReceipt = true;
  dispatch = false;
  cleanup = false;
  await assert.rejects(
    transport.request("bx_owned", input),
    HostTransportError,
  );
  assert.equal(dispatch, false);
  assert.equal(cleanup, true);
});

test("oversize import control uses an authenticated capability without leaking its bearer or replaying failures", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  await state.transaction((tx) => {
    tx.put("boat-host/bx_owned", "allocation");
    tx.put("allocation", { id: "bx_owned", retired: false });
  });
  const input: HostRequest = {
    version: 1,
    id: "bulk",
    action: "import-chunk",
    payload: { base64: Buffer.alloc(4 * 1024 * 1024, 7).toString("base64") },
  };
  const encoded = Buffer.from(JSON.stringify(input));
  assert.ok(
    encoded.length > 5 * 1024 * 1024 && encoded.length < 6 * 1024 * 1024,
  );
  let fault = "",
    dispatched = false,
    cleaned = false,
    uploads = 0,
    path = "";
  const api = new BoatApi("private-bearer", async (url, init) => {
    if (String(url).startsWith("https://upload.invalid/")) {
      uploads++;
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      assert.equal(init?.redirect, "manual");
      assert.equal(init?.method, "PUT");
      assert.deepEqual(Buffer.from(init?.body as Uint8Array), encoded);
      if (fault === "lost") throw Error("upload acknowledgement lost");
      return new Response(null, {
        status: fault === "redirect" ? 302 : 200,
        headers:
          fault === "redirect" ? { location: "https://other.invalid/" } : {},
      });
    }
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer private-bearer",
    );
    const body = JSON.parse(init?.body as string);
    if (String(url).endsWith("/files/upload-url")) {
      assert.equal(init?.method, "POST");
      assert.match(
        body.path,
        /^\/tmp\/jetski-control-[a-f0-9-]{36}\/request.json$/,
      );
      assert.equal(body.ttlSeconds, 900);
      path = body.path;
      return Response.json({
        url:
          fault === "scheme"
            ? "http://upload.invalid/object"
            : "https://upload.invalid/object?capability=private",
        method: fault === "method" ? "GET" : "PUT",
        expiresAt: new Date(
          Date.now() + (fault === "expired" ? -1000 : 900000),
        ).toISOString(),
      });
    }
    assert.equal(
      String(url).endsWith("/commands"),
      true,
      "never send oversized control to direct write_file",
    );
    assert.ok(Buffer.byteLength(body.command) < 4096);
    if (body.command.includes("hashlib")) {
      dispatched = true;
      assert.ok(body.command.includes(path));
      assert.ok(body.command.includes(`len(data)==${encoded.length}`));
      assert.ok(body.command.includes("sha256(data).hexdigest()"));
    }
    if (body.command.includes("os.rmdir")) cleaned = true;
    return Response.json({
      success: true,
      exitCode: 0,
      timedOut: false,
      stderr: "",
      stdout: JSON.stringify({ version: 1, id: input.id, result: true }),
    });
  });
  const transport = new BoatTransport(state, api);
  assert.equal((await transport.request("bx_owned", input)).result, true);
  assert.equal(dispatched, true);
  assert.equal(cleaned, true);
  assert.equal(uploads, 1);
  for (fault of ["lost", "redirect", "expired", "scheme", "method"]) {
    dispatched = false;
    cleaned = false;
    const before: number = uploads;
    await assert.rejects(
      transport.request("bx_owned", input),
      HostTransportError,
    );
    assert.equal(dispatched, false);
    assert.equal(cleaned, true);
    assert.equal(
      uploads,
      before + (["lost", "redirect"].includes(fault) ? 1 : 0),
      "uncertain upload is never retried",
    );
  }
});

test("binary import is opt-in, bounded and carries lease/image through verified upload and cleanup", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  const assignmentId = "a780fdde-0c04-4430-afee-7a80cf638c59";
  const path = `/tmp/jetski-checkpoint-imports/${assignmentId}/chunk.bin`;
  const raw = new Uint8Array(7 * 1024 * 1024).fill(37);
  let uploads = 0;
  const api = new BoatApi("private-bearer", async (url, init) => {
    assert.equal(init?.redirect, "manual");
    if (String(url).startsWith("https://upload.invalid/")) {
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      assert.equal(init?.method, "PUT");
      assert.deepEqual(init?.body, raw);
      uploads++;
      return new Response(null, { status: 200 });
    }
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer private-bearer",
    );
    assert.equal(JSON.parse(init?.body as string).path, path);
    return Response.json({
      method: "PUT",
      url: "https://upload.invalid/part",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
  });
  assert.equal(new BoatTransport(state, api).checkpointImport, undefined);
  const transport = new BoatTransport(state, api, undefined, {
    archiveWrites: true,
  });
  const lease = {
    owner: "owner",
    poolId: "pool",
    machineId: "bx_owned",
    slotId: "slot",
    sandboxId: "box",
    assignmentId,
    generation: 1,
  };
  const image = `image@sha256:${"a".repeat(64)}`;
  const actions: string[] = [];
  transport.request = async (host, request) => {
    assert.equal(host, "bx_owned");
    const payload = request.payload as Record<string, unknown>;
    assert.deepEqual(payload.lease, lease);
    assert.equal(payload.image, image);
    actions.push(request.action);
    let result: import("../src/core/contracts.js").Json = { closed: true };
    if (request.action === "import-file-begin")
      result = { path, chunkBytes: 16 * 1024 * 1024 };
    if (request.action === "import-file-chunk") {
      assert.equal(uploads, 1);
      assert.equal(payload.bytes, raw.length);
      assert.equal(payload.offset, 0);
      assert.equal(payload.sha256, "verified-digest");
      result = { offset: raw.length };
    }
    return { version: 1, id: request.id, result };
  };
  const sink = await transport.checkpointImport!("bx_owned", lease, image);
  assert.equal(sink.chunkBytes, 16 * 1024 * 1024);
  assert.deepEqual(await sink.write(0, raw, "verified-digest"), {
    offset: raw.length,
  });
  await sink.close();
  assert.deepEqual(actions, [
    "import-file-begin",
    "import-file-chunk",
    "import-file-close",
  ]);
  await assert.rejects(
    api.uploadFile("bx_owned", path, raw),
    /Invalid Boat file upload/,
  );
  await assert.rejects(
    api.uploadCheckpointPart(
      "bx_owned",
      path,
      new Uint8Array(16 * 1024 * 1024 + 1),
    ),
    /Invalid Boat file upload/,
  );
  assert.equal(uploads, 1);
});
