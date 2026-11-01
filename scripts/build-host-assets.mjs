import { readFile, writeFile } from "node:fs/promises";
import { BOAT_BOOTSTRAP_MODULES } from "../dist/providers/boat-bootstrap-embedded.js";

// Release artifact only: no credentials, operator configuration or generated state.
const root = new URL("../host/", import.meta.url);
const encoded = {};
for (const name of [...BOAT_BOOTSTRAP_MODULES, "install_bundle.py"]) {
  const path = name.endsWith(".c") ? `native/${name}` : name;
  const bytes = await readFile(new URL(path, root));
  const limit = name === "install_bundle.py" ? 32 * 1024 : 256 * 1024;
  if (!bytes.length || bytes.length > limit)
    throw Error("Host asset size bound");
  encoded[name] = bytes.toString("base64");
}
const source = `// Generated from this release's ordinary host sources. Do not edit.
const encoded = ${JSON.stringify(encoded)};
const decode = (source) => Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
export async function loadBoatBootstrapAssets() {
  const files = {};
  for (const [name, source] of Object.entries(encoded)) {
    if (name !== "install_bundle.py") files[name] = decode(source);
  }
  return {files, installer: decode(encoded["install_bundle.py"])};
}
`;
await writeFile(new URL("../dist/host-assets.js", import.meta.url), source);
await writeFile(
  new URL("../dist/host-assets.d.ts", import.meta.url),
  'export declare function loadBoatBootstrapAssets(): Promise<import("./providers/boat-bootstrap-embedded.js").BoatBootstrapAssets>;\n',
);
