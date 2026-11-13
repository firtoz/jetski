import { openJetski } from "@firtoz/jetski/node";

const jetski = await openJetski({
  provider: { kind: "boat", token: env("BOAT_API_TOKEN") },
  image: env("JETSKI_IMAGE"),
  // Controller state on the machine running this script, relative to its working directory.
  dataDirectory: "./.jetski",
  // Default local storage puts checkpoints in ./.jetski/objects on this machine.
});

const failures: unknown[] = [];
try {
  // Paid one-shot preparation, including the approved image. A long-running app
  // can do this before expected demand; it does not maintain a permanent pool.
  await jetski.prepareHosts({ count: 1 });
  for (const name of ["first", "second"]) {
    const sandbox = await jetski.create();
    const result = await sandbox.exec([
      "echo",
      `Hello from the ${name} session!`,
    ]);
    process.stdout.write(result.stdout);
    await sandbox.stop();
  }
} catch (error) {
  failures.push(error);
}
try {
  await jetski.close();
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
