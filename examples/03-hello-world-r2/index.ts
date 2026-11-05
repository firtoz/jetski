import { runSandbox } from "@firtoz/jetski/node";

const result = await runSandbox(
  {
    provider: { kind: "boat", token: env("BOAT_API_TOKEN") },
    image: env("JETSKI_IMAGE"),
    // Controller state on the machine running this script, relative to its working directory.
    dataDirectory: "./.jetski",
    // Checkpoint objects go to R2; controller metadata still lives in ./.jetski.
    storage: {
      kind: "s3",
      endpoint: env("R2_ENDPOINT"),
      bucket: env("R2_BUCKET"),
      prefix: "hello-world",
      region: "auto",
      credentials: {
        accessKeyId: env("R2_ACCESS_KEY_ID"),
        secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
      },
    },
  },
  ["echo", "Hello, world!"],
);

process.stdout.write(result.stdout);

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before running this example`);
  return value;
}
