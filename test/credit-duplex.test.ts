import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { creditDuplex } from "../src/transport/credit-duplex.js";

test("credit relay preserves binary bytes through a slow consumer and closes with an exact receipt", {
  timeout: 15000,
}, async (t) => {
  const host = fileURLToPath(new URL("../host/", import.meta.url));
  const echo =
    "import sys\nwhile True:\n b=sys.stdin.buffer.read1(8192)\n if not b: break\n sys.stdout.buffer.write(b);sys.stdout.buffer.flush()";
  const python = `import sys;sys.path.insert(0,${JSON.stringify(host)});import sdk_relay;sdk_relay.run([sys.executable,'-c',${JSON.stringify(echo)}])`;
  const child = spawn("python3", ["-I", "-c", python], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exit = once(child, "exit").then(([code]) => Number(code));
  const wire = creditDuplex({
    stdout: child.stdout,
    write: (b) => {
      child.stdin.write(b);
    },
    end: () => {
      child.stdin.end();
    },
    wait: () => exit,
    close: () => {
      child.kill();
    },
  });
  t.after(() => {
    wire.terminate();
    child.kill();
  });
  const expected = randomBytes(2 * 1024 * 1024);
  const writing = new Promise<void>((resolve, reject) => {
    wire.input.once("error", reject);
    wire.input.end(expected, resolve);
  });
  const chunks: Buffer[] = [];
  for await (const chunk of wire.output) {
    chunks.push(Buffer.from(chunk));
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  await writing;
  assert.equal(await wire.closed, 0);
  assert.deepEqual(Buffer.concat(chunks), expected);
});
