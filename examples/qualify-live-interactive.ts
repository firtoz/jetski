/** Generic controller-side qualification; every workload executes on its owned host. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Json, Scope, StateStore } from "../src/core/contracts.js";
import type { SandboxManager } from "../src/core/manager.js";

export async function qualifyLiveInteractive(
  manager: SandboxManager,
  state: StateStore,
  scope: Scope,
): Promise<Json> {
  const prefix = `qualification-interactive/${scope.owner}/${scope.sandbox}/`;
  const completed = await state.transaction((tx) =>
    tx.get<Json>(prefix + "done"),
  );
  if (completed) return completed;
  const id = (name: string) =>
    state.transaction((tx) => {
      const prior = tx.get<string>(prefix + name);
      if (prior) return prior;
      const next = randomUUID();
      tx.put(prefix + name, next);
      return next;
    });
  async function wait(check: () => Promise<boolean>) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await manager.reconcile(scope.owner);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw Error("Interactive qualification observation deadline");
  }
  async function output(command: string) {
    const result = (await manager.commandOutput(
      scope,
      command,
      "stdout",
      0,
      8192,
    )) as { base64: string };
    return Buffer.from(result.base64, "base64").toString();
  }
  async function successful(command: string) {
    await wait(async () => {
      const status = (await manager.commandStatus(scope, command)) as {
        phase: string;
        exitCode: number | null;
      };
      if (["failed", "cancelled", "uncertain"].includes(status.phase))
        throw Error(
          "Interactive command failed or uncertain; inspect existing ID",
        );
      if (status.phase !== "succeeded") return false;
      assert.equal(status.exitCode, 0);
      return true;
    });
  }
  const terminal = await id("terminal");
  const terminalStatus = (await manager.startTerminal(
    scope,
    terminal,
    [
      "/bin/sh",
      "-ec",
      'stty size; IFS= read -r value; test "$value" = jetski; stty size',
    ],
    "/workspace",
    120,
    { rows: 24, columns: 80 },
  )) as { phase: string };
  if (terminalStatus.phase !== "succeeded") {
    await wait(async () => (await output(terminal)).includes("24 80"));
    await manager.terminalInput(scope, terminal, await id("resize"), {
      kind: "resize",
      rows: 40,
      columns: 120,
    });
    await manager.terminalInput(scope, terminal, await id("stdin"), {
      kind: "stdin",
      base64: Buffer.from("jetski\n").toString("base64"),
    });
  }
  await successful(terminal);
  const terminalOutput = await output(terminal);
  assert.ok(
    terminalOutput.includes("24 80") && terminalOutput.includes("40 120"),
  );
  const signalled = await id("signal-terminal");
  const signalStatus = (await manager.startTerminal(
    scope,
    signalled,
    [
      "/bin/sh",
      "-ec",
      "trap 'printf SIGNALLED; exit 0' INT; printf SIGNAL-READY; while :; do sleep 1; done",
    ],
    "/workspace",
    120,
  )) as { phase: string };
  if (signalStatus.phase !== "succeeded") {
    await wait(async () => (await output(signalled)).includes("SIGNAL-READY"));
    await manager.terminalInput(scope, signalled, await id("signal"), {
      kind: "signal",
      signal: "INT",
    });
  }
  await successful(signalled);
  assert.ok((await output(signalled)).includes("SIGNALLED"));

  const tcpResult = await state.transaction((tx) =>
    tx.get<Json>(prefix + "tcp-result"),
  );
  if (!tcpResult) {
    const response = Buffer.from(
      Array.from({ length: 512 }, (_, i) => i % 256),
    );
    const listener = await id("tcp-listener");
    await manager.startCommand(scope, listener, [
      "/bin/sh",
      "-ec",
      `printf '%s' '${response.toString("base64")}' | base64 -d | nc -l -p 18085`,
    ]);
    const readiness = await id("tcp-readiness");
    await manager.startCommand(scope, readiness, [
      "/bin/sh",
      "-ec",
      "for i in $(seq 1 50); do grep -q ':46A5 .* 0A ' /proc/net/tcp /proc/net/tcp6 && exit 0; sleep 0.1; done; exit 1",
    ]);
    await successful(readiness);
    const exposure = await id("tcp-exposure"),
      stream = await id("tcp-stream");
    await manager.ports.expose(scope, exposure, 18085);
    assert.ok(manager.streams);
    // The stable stream ID cannot reopen after uncertain delivery. A resumed
    // runner must inspect its receipt, never invent a second connection identity.
    const connection = await manager.streams.open(
      scope,
      exposure,
      stream,
      AbortSignal.timeout(30000),
    );
    try {
      await connection.send(Buffer.from("jetski-live-tcp\n"));
      await connection.end();
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const bytes of connection.output) {
        length += bytes.length;
        assert.ok(length <= 512);
        chunks.push(bytes);
      }
      await connection.completed;
      assert.deepEqual(Buffer.concat(chunks), response);
      await wait(
        async () =>
          (await manager.streams!.status(scope, stream)).phase === "closed",
      );
      await successful(listener);
      await state.transaction((tx) =>
        tx.put(prefix + "tcp-result", { bytes: length, closed: true }),
      );
    } finally {
      connection.abort();
    }
  }
  await manager.ports.revoke(
    scope,
    await id("tcp-exposure"),
    await id("tcp-revoke"),
  );
  const result = {
    terminalInput: true,
    terminalResize: true,
    terminalSignal: true,
    binaryTcpBytes: 512,
    verifiedStreamClosure: true,
  };
  await state.transaction((tx) => tx.put(prefix + "done", result));
  return result;
}
