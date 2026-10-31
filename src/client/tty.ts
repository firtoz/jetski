import { once } from "node:events";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TerminalGeometry } from "../core/terminal-input.js";
import type { JetskiClient } from "../sdk.js";
import { SqliteState } from "../state/sqlite.js";

/** Node-only CLI adapter. No workload runs on this machine. */
export async function attachTty(
  client: JetskiClient,
  sandbox: string,
  terminal: string,
  id: string,
  directory: string,
): Promise<void> {
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const meta = await lstat(root);
  if (
    !meta.isDirectory() ||
    meta.isSymbolicLink() ||
    (meta.mode & 0o077) !== 0 ||
    (process.getuid && meta.uid !== process.getuid()) ||
    (await realpath(root)) !== root
  )
    throw Error(
      "Attachment state directory must be private, owned and not redirected",
    );
  const path = join(root, "terminal.sqlite");
  try {
    const file = await lstat(path);
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      (file.mode & 0o077) !== 0 ||
      (process.getuid && file.uid !== process.getuid())
    )
      throw Error("Unsafe attachment state file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const mask = process.umask(0o077);
  let state: SqliteState;
  try {
    state = new SqliteState(path);
  } finally {
    process.umask(mask);
  }
  const controller = new AbortController(),
    signal = controller.signal;
  const stdin = process.stdin,
    stdout = process.stdout;
  const originalRaw = stdin.isRaw;
  let raw = false,
    ended = false,
    failure: unknown;
  let resize: TerminalGeometry | undefined;
  let queuedBytes = 0;
  const queue: Buffer[] = [];
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  const detach = () => {
    controller.abort(new Error("Terminal detached"));
    notify();
  };
  const fail = (error: unknown) => {
    if (!signal.aborted) failure = error;
    detach();
  };
  const resized = () => {
    if (stdout.isTTY && stdout.rows > 0 && stdout.columns > 0)
      resize = { rows: stdout.rows, columns: stdout.columns };
    notify();
  };
  const readable = () => {
    while (!signal.aborted && stdin.readableLength && queuedBytes < 65536) {
      const count = Math.min(16384, stdin.readableLength, 65536 - queuedBytes);
      const chunk = stdin.read(count) as Buffer | null;
      if (!chunk) break;
      const at = stdin.isTTY ? chunk.indexOf(0x1d) : -1;
      if (at >= 0) {
        detach();
        return;
      }
      queue.push(chunk);
      queuedBytes += chunk.length;
    }
    notify();
  };
  const inputEnded = () => {
    ended = true;
    notify();
  };
  const deadline = () => AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  for (const event of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(event, detach);
  signal.addEventListener("abort", notify);
  try {
    const attachment = await client.attachTerminal(
      state,
      id,
      sandbox,
      terminal,
    );
    await attachment.resume(deadline());
    if (stdin.isTTY) {
      stdin.setRawMode(true);
      raw = true;
    }
    stdin.pause();
    stdin.on("readable", readable);
    stdin.on("end", inputEnded);
    stdin.on("error", fail);
    stdout.on("resize", resized);
    stdout.on("error", fail);
    resized();
    readable();
    const input = async () => {
      while (!signal.aborted) {
        if (resize) {
          const current = resize;
          resize = undefined;
          await attachment.send({ kind: "resize", ...current }, deadline());
          continue;
        }
        const chunk = queue.shift();
        if (chunk) {
          queuedBytes -= chunk.length;
          await attachment.send(
            { kind: "stdin", base64: chunk.toString("base64") },
            deadline(),
          );
          readable();
          continue;
        }
        if (ended) {
          detach();
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (signal.aborted) notify();
        });
      }
    };
    const output = async () => {
      for await (const chunk of client.followTerminal(sandbox, terminal, {
        offset: await attachment.cursor(),
        signal,
      })) {
        if (chunk.bytes.length && !stdout.write(chunk.bytes))
          await once(stdout, "drain", { signal });
        await attachment.acknowledgeOutput(chunk.offset, chunk.nextOffset);
      }
      detach();
    };
    await Promise.all([input().catch(fail), output().catch(fail)]);
    if (failure) throw failure;
  } catch (error) {
    if (!signal.aborted || failure) throw error;
  } finally {
    detach();
    stdin.removeListener("readable", readable);
    stdin.removeListener("end", inputEnded);
    stdin.removeListener("error", fail);
    stdout.removeListener("resize", resized);
    stdout.removeListener("error", fail);
    for (const event of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
      process.removeListener(event, detach);
    signal.removeEventListener("abort", notify);
    try {
      if (raw) stdin.setRawMode(originalRaw);
    } finally {
      stdin.pause();
      state.close();
    }
  }
}
