import assert from "node:assert/strict";
import test from "node:test";
import { fixtureSshKey } from "../examples/fixture-ssh-key.js";
import type { HostStreamRequest } from "../src/core/host-stream.js";
import { BoatApi } from "../src/providers/boat.js";
import { SqliteState } from "../src/state/sqlite.js";
import { BoatStreamTransport } from "../src/transport/boat-stream.js";

test("Boat SSH credentials survive lost registration; ownership and host pins fail closed", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  const allocation = {
    owner: "owner",
    id: "bx_owned",
    expiresAt: Date.now() + 60000,
    retired: false,
  };
  await state.transaction((tx) => {
    tx.put("boat-host/bx_owned", "allocation");
    tx.put("allocation", allocation);
  });
  const request: HostStreamRequest = {
    streamId: crypto.randomUUID(),
    lease: {
      machineId: "bx_owned",
      owner: "owner",
      poolId: "pool",
      slotId: "slot",
      sandboxId: "sandbox",
      assignmentId: "assignment",
      generation: 1,
    },
    image: "image",
    port: 8080,
  };
  let calls = 0,
    lost = true,
    key = fixtureSshKey().public,
    invalidEndpoint = false;
  const publicKeys: string[] = [];
  let controller = new AbortController();
  const api = new BoatApi("fixture", async (url, init) => {
    calls++;
    assert.equal(
      String(url),
      "https://boat.dev/api/v1/sandboxes/bx_owned/sshkey",
    );
    assert.equal(init?.method, "POST");
    const body = JSON.parse(init?.body as string);
    assert.deepEqual(Object.keys(body), ["key"]);
    assert.match(body.key, /^ssh-ed25519 /);
    publicKeys.push(body.key);
    if (lost) throw Error("registration response lost");
    // No socket is opened by this unit test. Pinning still runs before the
    // abort fence; the real encrypted wire is qualified on disposable CI.
    controller.abort();
    return Response.json({
      success: true,
      sshUser: "user",
      machineIp: "127.0.0.1",
      sshEndpoint: invalidEndpoint ? "localhost:22" : "127.0.0.1:2222",
      hostKey: key,
    });
  });
  const open = () =>
    new BoatStreamTransport(state, api).open(
      "bx_owned",
      request,
      controller.signal,
    );
  await assert.rejects(open(), /response lost/);
  lost = false;
  await assert.rejects(open(), /abort/i);
  assert.equal(
    publicKeys[0],
    publicKeys[1],
    "uncertain registration reuses persisted credential",
  );
  controller = new AbortController();
  key = fixtureSshKey().public;
  await assert.rejects(open(), /host key changed/);
  controller = new AbortController();
  invalidEndpoint = true;
  await assert.rejects(open(), /endpoint/);
  for (const changed of [
    { retired: true },
    { owner: "other" },
    { expiresAt: 0 },
  ]) {
    controller = new AbortController();
    const before = calls;
    await state.transaction((tx) =>
      tx.put("allocation", { ...allocation, ...changed }),
    );
    await assert.rejects(open(), /not actively owned/);
    assert.equal(calls, before);
  }
  await assert.rejects(
    new BoatStreamTransport(state, api).open("bx_foreign", request),
    /mismatch/,
  );
});
