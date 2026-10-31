import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { Json, StateStore } from "../src/core/contracts.js";
import { OperationJournal } from "../src/core/operations.js";
import { type PortContext, PortRegistry } from "../src/core/ports.js";
import {
  PREVIEW_GRANT_MS,
  PREVIEW_SESSION_MS,
  PreviewSessions,
} from "../src/core/preview-sessions.js";
import { SqliteState } from "../src/state/sqlite.js";

const scope = { owner: "alice", sandbox: "box" };
const binding = { exposureId: "port", origin: "https://preview.example" };
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "jetski-preview-session-"));
  const path = join(directory, "state.sqlite"),
    state = new SqliteState(path);
  let now = 1000000;
  const context: PortContext = {
    generation: 1,
    running: true,
    image: "fixture",
    lease: {
      owner: scope.owner,
      sandboxId: scope.sandbox,
      machineId: "host",
      poolId: "pool",
      slotId: "slot",
      assignmentId: "assignment",
      generation: 1,
    },
  };
  const databases = [state];
  t.after(async () => {
    for (const db of databases) db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const build = (store: StateStore) => {
    const operations = new OperationJournal(store, () => now);
    const ports = new PortRegistry(store, operations, () => context);
    return {
      operations,
      ports,
      sessions: new PreviewSessions(store, operations, ports, () => now),
    };
  };
  const result = build(state);
  await result.operations.generation(scope);
  await result.ports.expose(scope, "port", 8080);
  return {
    ...result,
    state,
    context,
    build,
    now: () => now,
    setNow: (value: number) => {
      now = value;
    },
    restart: () => {
      for (const db of databases.splice(0)) db.close();
      const db = new SqliteState(path);
      databases.push(db);
      return build(db);
    },
    reopen: () => {
      const db = new SqliteState(path);
      databases.push(db);
      return build(db);
    },
  };
}

test("preview grants replay across controllers without renewal and secrets stay out of public receipts", async (t) => {
  const f = await fixture(t),
    other = f.reopen();
  const [one, two] = await Promise.all([
    f.sessions.mint(scope, "grant", binding),
    other.sessions.mint(scope, "grant", binding),
  ]);
  assert.deepEqual(one, two);
  f.setNow(f.now() + 10000);
  assert.deepEqual(await other.sessions.mint(scope, "grant", binding), one);
  await assert.rejects(
    f.sessions.mint(scope, "grant", {
      ...binding,
      origin: "https://different.example",
    }),
    /identity conflict/,
  );
  await assert.rejects(
    f.sessions.mint(scope, "port", binding),
    /identity conflict/,
  );
  const operation = await f.state.transaction((tx) =>
    f.operations.getIn(tx, scope, "grant"),
  );
  const status = await f.sessions.status(scope, "grant");
  assert.equal(
    JSON.stringify(operation).includes(one.token.split(".")[1]!),
    false,
  );
  assert.equal(
    JSON.stringify(status).includes(one.token.split(".")[1]!),
    false,
  );
  assert.deepEqual(
    Object.keys(status).sort(),
    [
      "id",
      "exposureId",
      "origin",
      "generation",
      "grantExpiresAt",
      "sessionExpiresAt",
      "redeemed",
      "revoked",
    ].sort(),
  );
  await assert.rejects(f.sessions.status({ ...scope, owner: "bob" }, "grant"));
  assert.deepEqual(
    await f.restart().sessions.mint(scope, "grant", binding),
    one,
  );
});

test("grant and redemption survive lost committed acknowledgements without issuing another session", async (t) => {
  const f = await fixture(t);
  let lose = false,
    committed: unknown;
  const store: StateStore = {
    transaction: async (body) => {
      const result = await f.state.transaction(body);
      if (lose) {
        lose = false;
        committed = result;
        throw Error("Lost acknowledgement");
      }
      return result;
    },
  };
  const wrapped = f.build(store).sessions;
  lose = true;
  await assert.rejects(wrapped.mint(scope, "grant", binding));
  const grant = await f.reopen().sessions.mint(scope, "grant", binding);
  assert.deepEqual(grant, committed);
  lose = true;
  await assert.rejects(
    wrapped.redeem(scope, binding, grant.token, "redemption"),
  );
  const session = await f
    .reopen()
    .sessions.redeem(scope, binding, grant.token, "redemption");
  assert.deepEqual(session, committed);
  await assert.rejects(
    wrapped.redeem(scope, binding, grant.token, "different-redemption"),
  );
  assert.deepEqual(await wrapped.authenticate(scope, binding, session.cookie), {
    id: "grant",
    owner: "alice",
    expiresAt: session.expiresAt,
  });
});

test("bootstrap is one-use and sessions are bound to origin, owner, exposure and generation", async (t) => {
  const f = await fixture(t),
    other = f.reopen();
  const grant = await f.sessions.mint(scope, "grant", binding);
  const results = await Promise.allSettled([
    f.sessions.redeem(scope, binding, grant.token, "first"),
    other.sessions.redeem(scope, binding, grant.token, "second"),
  ]);
  assert.equal(
    results.filter((entry) => entry.status === "fulfilled").length,
    1,
  );
  const success = results.find((entry) => entry.status === "fulfilled");
  assert.ok(success?.status === "fulfilled");
  const cookie = success.value.cookie;
  assert.equal(
    await f.sessions.authenticate(scope, binding, grant.token),
    undefined,
  );
  assert.equal(
    await f.sessions.authenticate({ ...scope, owner: "bob" }, binding, cookie),
    undefined,
  );
  assert.equal(
    await f.sessions.authenticate(
      scope,
      { ...binding, origin: "https://foreign.example" },
      cookie,
    ),
    undefined,
  );
  assert.equal(
    await f.sessions.authenticate(
      scope,
      { ...binding, exposureId: "other" },
      cookie,
    ),
    undefined,
  );
  assert.equal(
    await f.sessions.authenticate(scope, binding, "grant." + "0".repeat(64)),
    undefined,
  );
  assert.equal(
    await f.sessions.authenticate(scope, binding, "malformed"),
    undefined,
  );
  await f.operations.advance({ ...scope, generation: 1 });
  f.context.generation = 2;
  assert.equal(
    await f.sessions.authenticate(scope, binding, cookie),
    undefined,
  );
  await assert.rejects(f.sessions.redeem(scope, binding, grant.token, "first"));
});

test("bootstrap and session expiries are fixed; revocation and port revocation fail closed", async (t) => {
  const f = await fixture(t),
    minted = f.now();
  const grant = await f.sessions.mint(scope, "grant", binding);
  const session = await f.sessions.redeem(
    scope,
    binding,
    grant.token,
    "redeem",
  );
  f.setNow(minted + PREVIEW_GRANT_MS);
  await assert.rejects(
    f.sessions.redeem(scope, binding, grant.token, "redeem"),
  );
  assert.ok(await f.sessions.authenticate(scope, binding, session.cookie));
  assert.deepEqual(await f.sessions.mint(scope, "grant", binding), grant);
  f.setNow(minted + PREVIEW_SESSION_MS);
  assert.equal(
    await f.sessions.authenticate(scope, binding, session.cookie),
    undefined,
  );
  const fresh = await f.sessions.mint(scope, "fresh", binding);
  const active = await f.sessions.redeem(scope, binding, fresh.token, "redeem");
  const revoked = await f.sessions.revoke(scope, "fresh", "revoke");
  assert.deepEqual(await f.sessions.revoke(scope, "fresh", "revoke"), revoked);
  assert.equal(
    await f.sessions.authenticate(scope, binding, active.cookie),
    undefined,
  );
  await assert.rejects(
    f.sessions.redeem(scope, binding, fresh.token, "redeem"),
  );
  const third = await f.sessions.mint(scope, "third", binding);
  const thirdSession = await f.sessions.redeem(
    scope,
    binding,
    third.token,
    "redeem",
  );
  await f.ports.revoke(scope, "port", "revoke-port");
  assert.equal(
    await f.sessions.authenticate(scope, binding, thirdSession.cookie),
    undefined,
  );
  await assert.rejects(f.sessions.mint(scope, "fourth", binding));
});

test("corrupt preview credential metadata cannot extend a session", async (t) => {
  const f = await fixture(t);
  const grant = await f.sessions.mint(scope, "grant", binding);
  const session = await f.sessions.redeem(
    scope,
    binding,
    grant.token,
    "redeem",
  );
  await f.state.transaction((tx) => {
    const key = "preview-grant/alice/box/grant";
    const record = tx.get<Record<string, Json>>(key)!;
    tx.put(key, { ...record, sessionExpiresAt: session.expiresAt + 1 });
  });
  assert.equal(
    await f.sessions.authenticate(scope, binding, session.cookie),
    undefined,
  );
  await assert.rejects(
    f.sessions.redeem(scope, binding, grant.token, "redeem"),
  );
  await assert.rejects(f.sessions.mint(scope, "grant", binding));
});
