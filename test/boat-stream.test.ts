import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fixtureSshKey } from "../examples/fixture-ssh-key.js";
import type { HostStreamRequest } from "../src/core/host-stream.js";
import { BoatApi } from "../src/providers/boat.js";
import { SqliteState } from "../src/state/sqlite.js";
import { BoatStreamTransport } from "../src/transport/boat-stream.js";

test("Boat SSH credentials survive lost registration; ownership and host pins fail closed", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  assert.throws(
    () =>
      new BoatStreamTransport(state, new BoatApi("fixture"), {
        cryptoSuite: "unapproved" as never,
      }),
    /Unsupported Boat stream crypto suite/,
  );
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

test("explicit stream crypto suite transfers binary data and rejects other cipher suites", {
  timeout: 30000,
}, async () => {
  const { default: ssh2 } = await import("ssh2");
  for (const cipher of ["aes256-ctr", "aes128-gcm@openssh.com"] as const) {
    const state = new SqliteState(":memory:");
    const key = fixtureSshKey();
    let admittedKey = "",
      executions = 0;
    const clients = new Set<import("ssh2").Connection>();
    const server = new ssh2.Server(
      {
        hostKeys: [key.private],
        algorithms: {
          cipher: [cipher],
          hmac: ["hmac-sha2-256-etm@openssh.com"],
        },
      },
      (client) => {
        clients.add(client);
        client.on("error", () => {});
        client.on("close", () => clients.delete(client));
        client.on("authentication", (ctx) => {
          if (ctx.method !== "publickey") return ctx.reject();
          const parsed = ssh2.utils.parseKey(admittedKey);
          if (
            parsed instanceof Error ||
            Array.isArray(parsed) ||
            !ctx.key.data.equals(parsed.getPublicSSH())
          )
            return ctx.reject();
          if (
            ctx.signature &&
            (!ctx.blob ||
              parsed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true)
          )
            return ctx.reject();
          ctx.accept();
        });
        client.on("ready", () =>
          client.on("session", (accept) =>
            accept().on("exec", (accept, reject, info) => {
              if (
                info.command !==
                "sudo -n env -i PATH=/usr/bin:/bin python3 -I /opt/jetski/host/control.py"
              )
                return reject();
              executions++;
              const channel = accept();
              let pending = Buffer.alloc(0),
                ready = false;
              channel.on("data", (chunk: Buffer) => {
                pending = Buffer.concat([pending, chunk]);
                if (!ready) {
                  const magic = Buffer.from("JETSKI-STREAM/1\n");
                  if (pending.length < magic.length + 4) return;
                  assert.deepEqual(pending.subarray(0, magic.length), magic);
                  const size = pending.readUInt32BE(magic.length);
                  if (pending.length < magic.length + 4 + size) return;
                  pending = pending.subarray(magic.length + 4 + size);
                  ready = true;
                  channel.write(Buffer.from([82, 0, 0, 0, 0]));
                }
                while (pending.length >= 5) {
                  const size = pending.readUInt32BE(1);
                  if (pending.length < 5 + size) return;
                  const frame = pending.subarray(0, 5 + size);
                  pending = pending.subarray(5 + size);
                  channel.write(frame);
                  if (frame[0] === 70) {
                    channel.exit(0);
                    channel.end();
                  }
                }
              });
            }),
          ),
        );
      },
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(typeof address === "object" && address);
    try {
      await state.transaction((tx) => {
        tx.put("boat-host/bx_wire", "allocation");
        tx.put("allocation", {
          id: "bx_wire",
          owner: "owner",
          retired: false,
          expiresAt: Date.now() + 60000,
        });
      });
      const api = new BoatApi("fixture", async (_url, init) => {
        admittedKey = JSON.parse(String(init?.body)).key;
        return Response.json({
          success: true,
          sshUser: "user",
          sshEndpoint: `127.0.0.1:${address.port}`,
          hostKey: key.public,
        });
      });
      const options = { cryptoSuite: "aes256-ctr-sha256-etm" as const };
      const transport = new BoatStreamTransport(state, api, options);
      const request: HostStreamRequest = {
        streamId: randomUUID(),
        lease: {
          machineId: "bx_wire",
          owner: "owner",
          poolId: "pool",
          slotId: "slot",
          sandboxId: "sandbox",
          assignmentId: "assignment",
          generation: 1,
        },
        image: "image",
        port: 3000,
      };
      if (cipher !== "aes256-ctr") {
        await assert.rejects(
          transport.open("bx_wire", request, AbortSignal.timeout(10000)),
          /SSH/,
        );
        assert.equal(executions, 0);
        continue;
      }
      const wire = await transport.open(
        "bx_wire",
        request,
        AbortSignal.timeout(10000),
      );
      try {
        const bytes = Buffer.from([0, 255, 13, 10, 128, 65]);
        await wire.send(bytes);
        await wire.end();
        const parts: Uint8Array[] = [];
        for await (const part of wire.output) parts.push(part);
        await wire.completed;
        assert.deepEqual(Buffer.concat(parts), bytes);
        assert.equal(executions, 1);
      } finally {
        wire.abort();
      }
    } finally {
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      state.close();
    }
  }
});
