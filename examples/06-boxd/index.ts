import { Boxd } from "@boxd-sh/sdk";
import { openJetski } from "@firtoz/jetski/node";
import { boxdHostFactory } from "@firtoz/jetski/providers/boxd-hosts";

const client = new Boxd({
  apiKey: env("BOXD_API_KEY"),
  region: "fra",
  maxRetries: 0,
  timeout: 330_000,
});
const jetski = await openJetski({
  provider: boxdHostFactory(client, {
    id: "boxd-personal-fra",
    close: () => client.close(),
  }),
  image: env("JETSKI_IMAGE"),
  // Metadata and local checkpoint objects live on this script's machine, not boxd.
  dataDirectory: "./.jetski",
});

try {
  const sandbox = await jetski.create();
  process.stdout.write(
    (await sandbox.exec(["echo", "Hello from Jetski on boxd!"])).stdout,
  );
} finally {
  await jetski.close();
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before running this example`);
  return value;
}
