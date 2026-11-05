import { openJetski } from "@firtoz/jetski/node";

const jetski = await openJetski({
  provider: {
    kind: "boxd",
    token: env("BOXD_API_KEY"),
    namespace: "boxd-personal-fra",
    region: "fra",
  },
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
