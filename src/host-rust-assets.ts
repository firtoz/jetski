/** Optional Node loader; neither the SDK nor core imports this module or a compiler. */
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import type { RustHostAssets } from "./providers/boat-bootstrap-rust.js";
import { validateHostBackend } from "./transport/host-backend.js";

export async function loadRustHostAssets(
  binary: string | URL,
  sha256: string,
): Promise<RustHostAssets> {
  validateHostBackend({ kind: "rust", sha256 });
  const file = await open(binary, "r");
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 64 || before.size > 6 * 1024 * 1024)
      throw Error("Native artifact bound");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!bytesRead) throw Error("Native artifact truncated");
      offset += bytesRead;
    }
    const after = await file.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      createHash("sha256").update(bytes).digest("hex") !== sha256
    )
      throw Error("Native artifact integrity");
    return {
      binary: bytes,
      sha256,
      installer: await readFile(
        new URL("../host-rust/install.py", import.meta.url),
      ),
    };
  } finally {
    await file.close();
  }
}
