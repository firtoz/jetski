import { Jetski } from "@firtoz/jetski/sdk";

// Storage lives with the configured controller (or its object store), not this client.
const jetski = new Jetski({
  url: env("JETSKI_URL"),
  token: env("JETSKI_TOKEN"),
});

const sandbox = await jetski.create({ image: env("JETSKI_IMAGE") });

try {
  const result = await sandbox.exec(["echo", "Hello, world!"]);
  process.stdout.write(result.stdout);
} finally {
  await sandbox.stop();
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before running this example`);
  return value;
}
