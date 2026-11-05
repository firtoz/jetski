import { readFile } from "node:fs/promises";

try {
  const c = JSON.parse(
    await readFile(
      process.env.JETSKI_CONFIG ?? "/etc/jetski/server.json",
      "utf8",
    ),
  );
  const token = process.env[c.principals[0].tokenEnv];
  if (!token) throw Error("Missing health credential");
  const response = await fetch(`http://127.0.0.1:${c.port ?? 8788}/v1/health`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok || !(await response.json()).ready) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
