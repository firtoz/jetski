import { readFile } from "node:fs/promises";
import type { SandboxSession } from "@firtoz/jetski/sdk";

/** Only run an artifact built from reviewed Voxl source. The manifest verifies
 * transport integrity; it is not an authorization signature for arbitrary code. */
export async function installDesktop(
  sandbox: SandboxSession,
  artifact: string,
  password: string,
) {
  await sandbox.writeFile("/workspace/voxl-password", password, {
    mode: 0o600,
  });
  await sandbox.writeFile(
    "/workspace/voxl-artifact.tar.gz",
    await readFile(artifact),
  );
  await sandbox.exec(
    [
      "python3",
      "-c",
      `import pathlib,tarfile,json,hashlib,os
out=pathlib.Path('/workspace/voxl');out.mkdir()
with tarfile.open('/workspace/voxl-artifact.tar.gz') as archive:
 for member in archive.getmembers():
  assert not member.issym() and not member.islnk() and (member.isfile() or member.isdir())
  assert (out/member.name).resolve().is_relative_to(out)
 archive.extractall(out,filter='data')
for name,meta in json.loads((out/'manifest.json').read_text()).items():
 data=(out/name).read_bytes()
 assert len(data)==meta['bytes'] and hashlib.sha256(data).hexdigest()==meta['sha256']
os.chmod(out/'voxl',0o755)
os.unlink('/workspace/voxl-artifact.tar.gz')
`,
    ],
    { timeoutSeconds: 60 },
  );
  for (const name of ["page.html", "page-server.cjs"]) {
    await sandbox.writeFile(
      "/workspace/" + name,
      await readFile(new URL(name, import.meta.url)),
    );
  }
  // Publish executable init last, after assets and authentication are complete.
  await sandbox.writeFile(
    "/workspace/launch-desktop",
    await readFile(new URL("launch-desktop.sh", import.meta.url)),
    { mode: 0o755 },
  );
}
