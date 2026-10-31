import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { attachTty } from "../src/client/tty.js";
import { JetskiClient } from "../src/sdk.js";

test("TTY attachment rejects public or redirected state before remote contact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jetski-tty-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const client = new JetskiClient("http://127.0.0.1", "test", async () => {
    calls++;
    throw Error("Unexpected request");
  });
  await chmod(root, 0o755);
  await assert.rejects(
    attachTty(client, "sandbox", "terminal", "attachment", root),
    /private/,
  );
  await chmod(root, 0o700);
  const target = join(root, "protected");
  await writeFile(target, "preserve", { mode: 0o600 });
  await symlink(target, join(root, "terminal.sqlite"));
  await assert.rejects(
    attachTty(client, "sandbox", "terminal", "attachment", root),
    /Unsafe/,
  );
  assert.equal(await readFile(target, "utf8"), "preserve");
  assert.equal(calls, 0);
});
