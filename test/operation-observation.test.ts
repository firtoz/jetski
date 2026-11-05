import assert from "node:assert/strict";
import test from "node:test";
import { type SandboxApi, SandboxSession } from "../src/client/sandbox.js";
import type { Operation } from "../src/core/contracts.js";
import { JetskiClient, OperationOutcomeError } from "../src/sdk.js";

function operation(phase: Operation["phase"]): Operation {
  return {
    id: "existing",
    sandbox: "sandbox",
    owner: "owner",
    generation: 1,
    kind: "resume-memory",
    input: {},
    phase,
    createdAt: 1,
    updatedAt: 2,
    result: { memoryPreserved: true },
    error: null,
  };
}
test("SDK resumes observation using GET only, preserves result and propagates abort signal", async () => {
  let requests = 0;
  const client = new JetskiClient(
    "https://example.invalid",
    "token",
    async (url, init) => {
      assert.equal(init?.method, "GET");
      assert.ok(init?.signal);
      assert.equal(
        new URL(String(url)).pathname,
        "/v1/sandboxes/sandbox/operations/existing",
      );
      return Response.json(
        operation(++requests === 1 ? "running" : "succeeded"),
      );
    },
  );
  assert.deepEqual(
    (await client.waitForOperation("sandbox", "existing")).result,
    { memoryPreserved: true },
  );
  assert.equal(requests, 2);
  await assert.rejects(
    client.waitForOperation("sandbox", "existing", {
      signal: AbortSignal.abort(),
    }),
  );
  assert.equal(requests, 2, "abort never sends a mutation or observation");
});
test("uncertain/failed outcomes remain typed and are never replayed; mismatched identities fail closed", async () => {
  for (const phase of ["uncertain", "failed"] as const) {
    let requests = 0;
    const client = new JetskiClient(
      "https://example.invalid",
      "token",
      async () => {
        requests++;
        return Response.json(operation(phase));
      },
    );
    await assert.rejects(
      client.waitForOperation("sandbox", "existing"),
      (error: unknown) =>
        error instanceof OperationOutcomeError &&
        error.operation.phase === phase &&
        error.operation.id === "existing",
    );
    assert.equal(requests, 1);
  }
  const client = new JetskiClient(
    "https://example.invalid",
    "token",
    async () => Response.json({ ...operation("succeeded"), id: "different" }),
  );
  await assert.rejects(
    client.waitForOperation("sandbox", "existing"),
    /identity mismatch/,
  );
});
test("embedded session observation shares the API and timeout never cancels remote work", async () => {
  let observations = 0;
  const api = {
    operation: async () => {
      observations++;
      return operation("running");
    },
  } as Pick<SandboxApi, "operation">;
  // Only operation observation is allowed in this fixture; any mutation would fail.
  const sandbox = SandboxSession.attach({}, () => api as SandboxApi, {
    id: "sandbox",
    createOperation: "create",
  } as Parameters<typeof SandboxSession.attach>[2]);
  await assert.rejects(
    sandbox.waitForOperation("existing", { waitTimeoutMs: 5 }),
  );
  assert.equal(observations, 1);
});
