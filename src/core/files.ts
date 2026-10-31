/** Bounded observations of live persistent files, not filesystem snapshots. */
export const FILE_CHUNK_BYTES = 256 * 1024;
export type FileChunk = {
  base64: string;
  offset: number;
  nextOffset: number;
  size: number;
  eof: boolean;
  version: string;
  sha256: string;
};
export type FileListing = {
  entries: Array<{
    name: string;
    kind: "file" | "directory" | "symlink" | "other";
    mode: number;
    size: number;
  }>;
  next: string | null;
  version: string;
};
export function persistentPath(path: string): string {
  const parts = path.split("/");
  if (
    new TextEncoder().encode(path).length > 4096 ||
    path.includes("\0") ||
    !(
      path === "/workspace" ||
      path.startsWith("/workspace/") ||
      path === "/home/sandbox" ||
      path.startsWith("/home/sandbox/")
    ) ||
    parts.slice(1).some((part) => ["", ".", ".."].includes(part))
  )
    throw Error("Invalid persistent path");
  return path;
}
