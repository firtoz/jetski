import type { CheckpointRoot } from "./checkpoints.js";
import { validateOutputRoot } from "./command-output.js";
import { parseArchive } from "./transfer.js";

/** A metadata-free root explicitly retains its listed objects only. All typed
 * payloads must use a recognized format and describe exactly those objects. */
export function validateRootPayload(root: CheckpointRoot): void {
  if (root.metadata === null) return;
  if (
    typeof root.metadata === "object" &&
    !Array.isArray(root.metadata) &&
    root.metadata.kind === "command-output"
  ) {
    validateOutputRoot(root);
    return;
  }
  const archive = parseArchive(root.metadata);
  if (archive.frames.length !== root.frames.length)
    throw Error("Checkpoint payload frame count mismatch");
  for (const [index, expected] of archive.frames.entries()) {
    const actual = root.frames[index]!;
    if (
      !actual ||
      actual.bytes !== expected.bytes ||
      actual.sha256 !== expected.sha256
    )
      throw Error("Checkpoint payload frame mismatch");
  }
}
