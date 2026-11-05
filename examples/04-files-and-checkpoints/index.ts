import { openJetski } from "@firtoz/jetski/node";

const jetski = await openJetski({
  provider: { kind: "boat", token: env("BOAT_API_TOKEN") },
  image: env("JETSKI_IMAGE"),
  // Controller state on the machine running this script, relative to its working directory.
  dataDirectory: "./.jetski",
  // Default local storage puts checkpoints in ./.jetski/objects on this machine.
});

try {
  const sandbox = await jetski.create();
  console.log("Original sandbox:", sandbox.id);
  await sandbox.writeFile("/workspace/hello.txt", "Hello, durable world!\n");
  // Publish the files and release the original assignment.
  const checkpoint = await sandbox.checkpoint({ releaseHost: true });
  await sandbox.pin(checkpoint.id, "example");
  // A distinct sandbox gets its own durable copy of this checkpoint.
  const restored = await jetski.fromCheckpoint({
    sourceSandboxId: sandbox.id,
    checkpointId: checkpoint.id,
  });
  await restored.resume();
  console.log("Restored sandbox:", restored.id);
  process.stdout.write(await restored.readText("/workspace/hello.txt"));
} finally {
  await jetski.close();
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before running this example`);
  return value;
}
