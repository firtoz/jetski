import { randomUUID } from "node:crypto";
import { mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Local single-controller guard. Never steals a crash-stale lock automatically. */
export async function acquireControllerLock(
  directory: string,
): Promise<() => Promise<void>> {
  const lock = join(directory, "controller.lock");
  await mkdir(lock, { mode: 0o700 }).catch(() => {
    throw Error(
      "Controller lock unavailable; stop the other controller or follow the crash-recovery runbook",
    );
  });
  const receipt = JSON.stringify({
    version: 1,
    pid: process.pid,
    nonce: randomUUID(),
  });
  await writeFile(join(lock, "owner.json"), receipt, {
    flag: "wx",
    mode: 0o600,
  });
  let released = false;
  return async () => {
    if (released) return;
    if ((await readFile(join(lock, "owner.json"), "utf8")) !== receipt)
      throw Error("Controller lock ownership changed");
    await unlink(join(lock, "owner.json"));
    await rmdir(lock);
    released = true;
  };
}
