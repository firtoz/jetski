import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostRequest, HostTransport } from "../src/core/transport.js";
import { SshHostProvider } from "../src/providers/ssh.js";
import { SqliteState } from "../src/state/sqlite.js";
import {
  type SshHost,
  SshTransport,
  sshArguments,
} from "../src/transport/ssh.js";

const host: SshHost = {
  id: "host",
  hostname: "example.test",
  user: "operator",
  port: 22,
  privateKeyPath: "/private/key",
  knownHostsPath: "/private/hosts",
};

test("SSH uses explicit pinned hosts and credentials without inherited agents or shell input", async () => {
  const args = sshArguments(host);
  for (const option of [
    "StrictHostKeyChecking=yes",
    "BatchMode=yes",
    "IdentitiesOnly=yes",
    "IdentityAgent=none",
    "ClearAllForwardings=yes",
  ])
    assert.ok(args.includes(option));
  assert.equal(
    args.at(-1),
    "env -i PATH=/usr/bin:/bin python3 -I /opt/jetski/host/control.py",
  );
  assert.throws(
    () => sshArguments({ ...host, hostname: "example.test; echo injected" }),
    /Invalid/,
  );
  assert.throws(
    () => sshArguments({ ...host, user: "root -o ProxyCommand=evil" }),
    /Invalid/,
  );
  assert.throws(() => new SshTransport([host, host]), /Duplicate/);
  const transport = new SshTransport([host]);
  await assert.rejects(
    transport.request("foreign", {
      version: 1,
      id: "op",
      action: "status",
      payload: null,
    }),
    /not configured/,
  );
});

test("adopted hosts retain owner binding and stale retirement cannot free new work", async (t) => {
  const state = new SqliteState(":memory:");
  t.after(() => state.close());
  let requests = 0;
  const transport: HostTransport = {
    request: async (_host: string, request: HostRequest) => {
      requests++;
      return { version: 1, id: request.id, result: { ready: true } };
    },
  };
  const provider = new SshHostProvider(["host"], state, transport);
  const first = await provider.allocate({
    owner: "alice",
    operationId: "first",
    expiresAt: 1000,
  });
  assert.deepEqual(first, { id: "host", allocationId: "first" });
  assert.deepEqual(
    await provider.allocate({
      owner: "alice",
      operationId: "first",
      expiresAt: 1000,
    }),
    first,
  );
  await assert.rejects(
    provider.allocate({
      owner: "alice",
      operationId: "second",
      expiresAt: 1000,
    }),
    /queued/,
  );
  await provider.retire(first.id, first.allocationId);
  await assert.rejects(
    provider.allocate({ owner: "bob", operationId: "bob", expiresAt: 1000 }),
    /queued/,
  );
  const next = await provider.allocate({
    owner: "alice",
    operationId: "second",
    expiresAt: 1000,
  });
  await assert.rejects(provider.retire(first.id, first.allocationId), /Stale/);
  assert.deepEqual(await provider.inspect(next.id), { state: "ready" });
  await provider.retire(next.id, next.allocationId);
  assert.equal(
    requests,
    1,
    "adoption and retirement never issue a shutdown or delete command",
  );
});
