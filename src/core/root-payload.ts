import { checkpointLayout } from "./checkpoint-layout.js";
import type { CheckpointRoot } from "./checkpoints.js";
import { validateOutputRoot } from "./command-output.js";

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
  checkpointLayout(root);
}
