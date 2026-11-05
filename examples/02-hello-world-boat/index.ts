import { runSandbox } from "@firtoz/jetski/node";

const result = await runSandbox(
  {
    provider: { kind: "boat", token: env("BOAT_API_TOKEN") },
    image: env("JETSKI_IMAGE"),
    // Controller state on the machine running this script, relative to its working directory.
    dataDirectory: "./.jetski",
    // Checkpoint objects also stay here: ./.jetski/objects, NOT on the Boat disk.
    storage: { kind: "local" },
  },
  ["echo", "Hello, world!"],
);

process.stdout.write(result.stdout);

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before running this example`);
  return value;
}
