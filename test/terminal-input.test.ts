import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Json } from "../src/core/contracts.js";
import type { HostLease } from "../src/core/pool.js";
import {
  type TerminalInput,
  TerminalInputJournal,
  terminalFrame,
} from "../src/core/terminal-input.js";
import { SqliteState } from "../src/state/sqlite.js";

test("terminal outcomes survive lost admission ACK, controller restart and host release", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jetski-terminal-")),
    path = join(directory, "state.sqlite");
  let state = new SqliteState(path);
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const scope = { owner: "alice", sandbox: randomUUID() },
    command = randomUUID();
  const lease = {
    owner: scope.owner,
    sandboxId: scope.sandbox,
    machineId: "host",
    poolId: "pool",
    slotId: randomUUID(),
    assignmentId: randomUUID(),
    generation: 1,
  };
  const context = {
    ...scope,
    command,
    id: randomUUID(),
    lease,
    image: "example/linux@sha256:" + "a".repeat(64),
  };
  let closed = false,
    retired = false,
    lose = true,
    admissions = 0;
  const host = new Map<string, Json>();
  const request = async (
    _lease: HostLease,
    action: string,
    raw: Json,
  ): Promise<Json> => {
    if (retired) throw Error("Host retired");
    const payload = raw as { inputId: string; input: TerminalInput };
    if (action === "terminal-input-status")
      return (
        host.get(payload.inputId) ?? {
          id: payload.inputId,
          phase: "absent",
          closed,
        }
      );
    assert.equal(action, "terminal-input");
    assert.equal(closed, false);
    const bytes = terminalFrame(payload.input);
    admissions++;
    const receipt = {
      id: payload.inputId,
      sequence: 0,
      phase: "sent",
      kind: payload.input.kind,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    host.set(payload.inputId, receipt);
    if (lose) {
      lose = false;
      throw Error("admission ACK lost");
    }
    return receipt;
  };
  let journal = new TerminalInputJournal(state, request);
  const input: TerminalInput = { kind: "stdin", base64: "AP8N" };
  await assert.rejects(
    journal.admit(context, input, () => {}),
    /ACK lost/,
  );
  state.close();
  state = new SqliteState(path);
  journal = new TerminalInputJournal(state, request);
  await journal.reconcile(scope.owner);
  assert.deepEqual(
    await journal.status(scope, command, context.id),
    host.get(context.id),
  );
  assert.equal(admissions, 1);
  await assert.rejects(
    journal.status({ ...scope, owner: "foreign" }, command, context.id),
    /unavailable/,
  );
  await assert.rejects(
    journal.admit(context, { kind: "close" }, () => {}),
    /identity conflict/,
  );
  const missing = { ...context, id: randomUUID() };
  const interrupted = new TerminalInputJournal(state, async () => {
    throw Error("controller stopped before dispatch");
  });
  await assert.rejects(
    interrupted.admit(missing, { kind: "close" }, () => {}),
    /before dispatch/,
  );
  closed = true;
  await journal.settle(scope);
  assert.equal(
    ((await journal.status(scope, command, missing.id)) as { phase: string })
      .phase,
    "cancelled",
  );
  assert.equal(admissions, 1);
  retired = true;
  await journal.settle(scope);
  assert.deepEqual(
    await journal.admit(context, input, () => {
      throw Error("No new admission after release");
    }),
    host.get(context.id),
  );
});

test("terminal frame validation bounds input and matches the host wire format", () => {
  assert.deepEqual(
    [...terminalFrame({ kind: "resize", rows: 40, columns: 100 })],
    [82, 0, 0, 0, 4, 0, 40, 0, 100],
  );
  assert.deepEqual(
    [...terminalFrame({ kind: "stdin", base64: "AP8N" })],
    [73, 0, 0, 0, 3, 0, 255, 13],
  );
  for (const input of [
    { kind: "stdin", base64: "" },
    { kind: "resize", rows: true, columns: 80 },
    { kind: "signal", signal: "KILL" },
    { kind: "close", extra: true },
  ])
    assert.throws(() => terminalFrame(input as TerminalInput));
});
