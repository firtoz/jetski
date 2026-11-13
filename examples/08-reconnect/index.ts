import { open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  Jetski,
  JetskiOperationError,
  type SandboxOperation,
} from "@firtoz/jetski/sdk";

// This is CLIENT identity storage. Checkpoints/controller metadata live with the service.
const path = resolve(process.env.JETSKI_RECOVERY_LOG ?? "./reconnect.ndjson");
const mode = process.argv[2];
if (mode !== "start" && mode !== "observe")
  throw Error("Use: node index.ts start | observe");
if (mode === "start") {
  // Fail before any admission if a recovery journal already exists. Never replay the script.
  const file = await open(path, "wx", 0o600);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
const jetski = new Jetski({
  url: env("JETSKI_URL"),
  token: env("JETSKI_TOKEN"),
  onOperation: persist,
});

if (mode === "start") {
  const sandbox = await jetski.create({ image: env("JETSKI_IMAGE") });
  const command = await sandbox.startCommand([
    "sh",
    "-c",
    "sleep 2; printf 'recovered\\n'",
  ]);
  try {
    await command.wait({ signal: AbortSignal.abort() });
  } catch (error) {
    if (
      !(error instanceof JetskiOperationError) ||
      !(error.cause instanceof DOMException) ||
      error.cause.name !== "AbortError"
    )
      throw error;
  }
  console.log(
    "Observation interrupted; remote work was not cancelled. Run observe with the same journal.",
  );
} else {
  const saved = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(parse);
  const create = saved.find((item) => item.kind === "create");
  if (!create)
    throw Error(
      "No create identity; investigate the journal before admitting work",
    );
  const sandbox = await jetski.get(create.sandboxId);
  await sandbox.waitForOperation(create.operationId);
  const command = saved.find((item) => item.kind === "exec");
  if (!command)
    throw Error(
      "No command identity; reconcile create before explicitly deciding what to admit next",
    );
  if (command.sandboxId !== sandbox.id) throw Error("Recovery scope mismatch");
  const result = await sandbox.command(command.operationId).wait(); // GET only; never starts again.
  process.stdout.write(result.stdout);
  // Continue only after confirmed command completion. Re-observe an existing stop after lost ACK.
  const stop = saved.find((item) => item.kind === "stop");
  if (stop) await sandbox.waitForOperation(stop.operationId);
  else await sandbox.stop();
  console.log(
    "Reconciled and durably stopped; retained history remains on the controller.",
  );
}

async function persist(operation: SandboxOperation): Promise<void> {
  const file = await open(path, "a", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(operation)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}
function parse(line: string): {
  kind: string;
  sandboxId: string;
  operationId: string;
} {
  const value: unknown = JSON.parse(line);
  if (
    !value ||
    typeof value !== "object" ||
    !("kind" in value) ||
    typeof value.kind !== "string" ||
    !("sandboxId" in value) ||
    typeof value.sandboxId !== "string" ||
    !("operationId" in value) ||
    typeof value.operationId !== "string"
  )
    throw Error("Invalid recovery journal; do not admit replacements");
  return {
    kind: value.kind,
    sandboxId: value.sandboxId,
    operationId: value.operationId,
  };
}
function env(name: string): string {
  const value = process.env[name];
  if (!value) throw Error(`Set ${name}`);
  return value;
}
