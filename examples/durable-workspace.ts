/** Explicit SDK steps against an existing server. May allocate billable compute. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { JetskiClient } from "../src/sdk.js";

const [step, planPath, image] = process.argv.slice(2);
const steps = ["init", "create", "write", "stop", "resume", "read", "finish"];
const usage = `Usage: npx tsx examples/durable-workspace.ts ${steps.join("|")} PRIVATE_PLAN_JSON [IMAGE_DIGEST_FOR_INIT]`;
const contents = "Hello from a durable Jetski workspace.\n";
type Plan = {
  version: 1;
  url: string;
  image: string;
  sandbox: string;
  create: string;
  write: string;
  stop: string;
  resume: string;
  finish: string;
};

if (step === "--help") {
  console.log(usage);
} else {
  if (!step || !steps.includes(step) || !planPath) throw Error(usage);
  if (step === "init") {
    if (!image || !/@sha256:[a-f0-9]{64}$/.test(image))
      throw Error("Supply an operator-approved image digest");
    const plan: Plan = {
      version: 1,
      url: process.env.JETSKI_URL ?? "http://127.0.0.1:8788",
      image,
      sandbox: randomUUID(),
      create: randomUUID(),
      write: randomUUID(),
      stop: randomUUID(),
      resume: randomUUID(),
      finish: randomUUID(),
    };
    // Never overwrite a previous plan or generate replacement IDs on retry.
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      "Plan saved. Review it before create; no network request made.",
    );
  } else {
    const plan = JSON.parse(await readFile(planPath, "utf8")) as Plan;
    if (plan.version !== 1) throw Error("Unsupported plan version");
    const token = process.env.JETSKI_TOKEN;
    if (!token) throw Error("JETSKI_TOKEN required");
    const client = new JetskiClient(plan.url, token);
    const deadline = Date.now() + 10 * 60_000;
    const wait = async (
      observe: () => Promise<unknown>,
      wanted: string,
    ): Promise<void> => {
      while (Date.now() < deadline) {
        const record = (await observe()) as { phase?: string };
        if (record.phase === wanted) return;
        if (
          [
            "failed",
            "uncertain",
            "cancelled",
            "quarantined",
            "deleted",
          ].includes(record.phase ?? "")
        )
          throw Error(
            `Observed ${record.phase}; preserve plan and inspect receipts`,
          );
        await delay(500);
      }
      throw Error(
        "Observation deadline; work may continue. Keep original IDs.",
      );
    };
    const operation = (id: string) =>
      wait(() => client.operation(plan.sandbox, id), "succeeded");
    switch (step) {
      case "create":
        await client.createSandbox(plan.sandbox, plan.image, plan.create);
        await operation(plan.create);
        break;
      case "write":
        await client.startCommand(plan.sandbox, plan.write, [
          "/bin/sh",
          "-ec",
          "printf '%s\\n' 'Hello from a durable Jetski workspace.' > /workspace/hello.txt",
        ]);
        await wait(
          () => client.commandStatus(plan.sandbox, plan.write),
          "succeeded",
        );
        break;
      case "stop":
      case "finish":
        await client.stopSandbox(plan.sandbox, plan[step]);
        await operation(plan[step]);
        break;
      case "resume":
        await client.resume(plan.sandbox, plan.resume);
        await operation(plan.resume);
        break;
      case "read": {
        const parts: Buffer[] = [];
        for await (const bytes of client.readFileStream(
          plan.sandbox,
          "/workspace/hello.txt",
        ))
          parts.push(Buffer.from(bytes));
        assert.equal(Buffer.concat(parts).toString("utf8"), contents);
        console.log(contents.trim());
        break;
      }
    }
    console.log(`${step}: complete; sandbox ${plan.sandbox}`);
  }
}
