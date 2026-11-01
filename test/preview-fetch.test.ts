import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { HostConnection } from "../src/core/host-stream.js";
import { OperationJournal } from "../src/core/operations.js";
import { type PortContext, PortRegistry } from "../src/core/ports.js";
import { PreviewSessions } from "../src/core/preview-sessions.js";
import { createFetchPreviewGateway } from "../src/server/preview-fetch.js";
import { SqliteState } from "../src/state/sqlite.js";

const scope = { owner: "alice", sandbox: "box" },
  binding = { origin: "https://preview.example", exposureId: "port" };
async function fixture(t: TestContext) {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  const operations = new OperationJournal(state);
  const context: PortContext = {
    generation: 1,
    running: true,
    image: "image",
    lease: {
      owner: "alice",
      sandboxId: "box",
      machineId: "host",
      poolId: "pool",
      slotId: "slot",
      assignmentId: "assignment",
      generation: 1,
    },
  };
  const ports = new PortRegistry(state, operations, () => context),
    sessions = new PreviewSessions(state, operations, ports);
  await operations.generation(scope);
  await ports.expose(scope, "port", 3000);
  let opens = 0,
    aborts = 0,
    sent = "",
    stall = false;
  const options = {
    route: { origin: binding.origin, ...scope, exposure: "port" },
    controlOrigins: ["https://control.example"],
    sessions,
    async open(): Promise<HostConnection> {
      opens++;
      let finish = () => {};
      const completed = new Promise<void>((r) => (finish = r));
      return {
        output: (async function* () {
          yield new TextEncoder().encode(
            "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nSet-Cookie: untrusted=1\r\n\r\n",
          );
          if (stall) await new Promise(() => {});
          yield new Uint8Array([0, 255, 65]);
          finish();
        })(),
        async send(bytes) {
          sent += new TextDecoder().decode(bytes);
        },
        async end() {},
        abort() {
          aborts++;
          finish();
        },
        completed,
      };
    },
    upgrade() {
      throw Error("No socket fixture");
    },
  };
  const gateway = createFetchPreviewGateway(options),
    ctx = { waitUntil: (_p: Promise<void>) => {} };
  const call = (path: string, init?: RequestInit) =>
    gateway(new Request(binding.origin + path, init), ctx);
  const grant = await sessions.mint(scope, "grant", binding);
  const redeem = () =>
    call("/.jetski/redeem", {
      method: "POST",
      headers: { origin: binding.origin, "content-type": "application/json" },
      body: JSON.stringify({ token: grant.token, redemption: "redeem" }),
    });
  return {
    options,
    sessions,
    gateway,
    ctx,
    call,
    redeem,
    counts: () => ({ opens, aborts, sent }),
    stall: () => {
      stall = true;
    },
  };
}
test("Fetch preview authenticates bootstrap cookies before opening and strips workload credentials", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("/")).status, 401);
  assert.equal(
    (await f.call("/", { headers: { origin: "https://foreign.example" } }))
      .status,
    403,
  );
  assert.equal(
    (await f.gateway(new Request("https://control.example/"), f.ctx)).status,
    404,
  );
  assert.equal(f.counts().opens, 0);
  const page = await f.call("/.jetski/bootstrap");
  assert.equal(page.status, 200);
  assert.match(
    page.headers.get("content-security-policy") ?? "",
    /script-src 'sha256-/,
  );
  assert.match(await page.text(), /history.replaceState/);
  const redeemed = await f.redeem();
  assert.equal(redeemed.status, 204);
  const cookie = redeemed.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  assert.match(
    redeemed.headers.get("set-cookie") ?? "",
    /Secure; HttpOnly; SameSite=Strict/,
  );
  const repeated = await f.redeem();
  assert.equal(repeated.headers.get("set-cookie")?.split(";")[0], cookie);
  const response = await f.call("/path", {
    headers: { cookie, authorization: "private" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual(
    new Uint8Array(await response.arrayBuffer()),
    new Uint8Array([0, 255, 65]),
  );
  assert.equal(f.counts().opens, 1);
  assert.ok(!f.counts().sent.includes("private"));
  assert.ok(!f.counts().sent.includes(cookie));
  assert.equal(
    (await f.call("/", { headers: { cookie: cookie + "; " + cookie } })).status,
    401,
  );
});
test("Fetch preview refuses cross-origin redemption and oversized bodies", async (t) => {
  const f = await fixture(t);
  for (const [origin, body] of [
    ["https://foreign.example", "{}"],
    [binding.origin, "x".repeat(8193)],
  ]) {
    assert.equal(
      (
        await f.call("/.jetski/redeem", {
          method: "POST",
          headers: { origin: origin!, "content-type": "application/json" },
          body: body!,
        })
      ).status,
      403,
    );
  }
  assert.equal(f.counts().opens, 0);
  assert.throws(
    () =>
      createFetchPreviewGateway({
        ...f.options,
        controlOrigins: [binding.origin],
      }),
    /isolated/,
  );
});
test("revoking a preview session aborts an already streaming response", async (t) => {
  const f = await fixture(t);
  const response = await f.redeem();
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  f.stall();
  const stream = await f.call("/", { headers: { cookie } });
  const body = stream.arrayBuffer();
  await f.sessions.revoke(scope, "grant", "revoke");
  await assert.rejects(body);
  assert.ok(f.counts().aborts > 0);
  assert.equal((await f.call("/", { headers: { cookie } })).status, 401);
});

test("preview framing remains disabled unless explicitly allowed for configured controls", async (t) => {
  const f = await fixture(t);
  assert.throws(
    () =>
      createFetchPreviewGateway({
        ...f.options,
        frameAncestors: ["https://foreign.example"],
      }),
    /control origin/,
  );
  const defaultPage = await f.call("/.jetski/bootstrap");
  assert.match(
    defaultPage.headers.get("content-security-policy") ?? "",
    /frame-ancestors 'none'/,
  );
  const gateway = createFetchPreviewGateway({
    ...f.options,
    frameAncestors: ["https://control.example"],
  });
  const page = await gateway(
    new Request(binding.origin + "/.jetski/bootstrap"),
    f.ctx,
  );
  assert.match(
    page.headers.get("content-security-policy") ?? "",
    /frame-ancestors https:\/\/control.example;/,
  );
  const redeemed = await f.redeem(),
    cookie = redeemed.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const response = await gateway(
    new Request(binding.origin + "/", { headers: { cookie } }),
    f.ctx,
  );
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /frame-ancestors https:\/\/control.example$/,
  );
  await response.arrayBuffer();
});
