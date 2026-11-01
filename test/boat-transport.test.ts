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
        timeoutSeconds: 60,
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
    action: "import_chunk",
    payload: "b".repeat(350000),
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
