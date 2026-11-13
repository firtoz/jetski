import { Jetski } from "@firtoz/jetski/sdk";

// Storage lives with the configured controller (or its object store), not this client.
const jetski = new Jetski({
  url: env("JETSKI_URL"),
  token: env("JETSKI_TOKEN"),
});

const sandbox = await jetski.create({ image: env("JETSKI_IMAGE") });

const failures: unknown[] = [];
try {
  const result = await sandbox.exec(["echo", "Hello, world!"]);
  process.stdout.write(result.stdout);
} catch (error) {
  failures.push(error);
}
try {
  await sandbox.stop();
} catch (error) {
  failures.push(error);
}
if (failures.length)
  throw new AggregateError(failures, "Work or verified cleanup failed");

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before running this example`);
  return value;
}
