import { checkpointArchive } from "./checkpoint-layout.js";
import type { CheckpointRegistry, CheckpointRoot } from "./checkpoints.js";
import {
  canonical,
  identifier,
  type Scope,
  type StateStore,
  scopeKey,
} from "./contracts.js";
import type { Sandbox } from "./manager.js";
import type { OperationJournal } from "./operations.js";

export type CheckpointSummary = {
  id: string;
  publishedAt: number;
  retiredAt: number | null;
  pins: string[];
  bytes: number;
  expandedBytes: number;
  entries: number;
  sha256: string;
};
export type CheckpointPage = {
  checkpoints: CheckpointSummary[];
  next: string | null;
};
function summary(root: CheckpointRoot): CheckpointSummary | undefined {
  const metadata = root.metadata;
  if (
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    metadata.kind === "command-output"
  )
    return undefined;
  const archive = checkpointArchive(root);
  return {
    id: root.id,
    publishedAt: root.publishedAt,
    retiredAt: root.retiredAt,
    pins: [...root.pins].sort(),
    bytes: archive.bytes,
    expandedBytes: archive.expandedBytes,
    entries: archive.entries,
    sha256: archive.sha256,
  };
}
/** History visibility is separate from storage-object/internal actor visibility. */
export class CheckpointHistory {
  constructor(
    private state: StateStore,
    private registry: CheckpointRegistry,
    private operations: OperationJournal,
  ) {}
  async list(scope: Scope, after = "", limit = 100): Promise<CheckpointPage> {
    if (after) identifier(after);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw Error("Invalid checkpoint page");
    return this.state.transaction((tx) => {
      const sandbox = tx.get<Sandbox>(`sandbox/${scopeKey(scope)}`);
      if (!sandbox) throw Error("Sandbox unavailable");
      if (
        sandbox.generation === 1 &&
        ["queued", "starting"].includes(sandbox.phase) &&
        !sandbox.checkpoint
      )
        return { checkpoints: [], next: null };
      const rows = this.registry
        .rootsIn(tx, { ...scope, generation: sandbox.generation })
        .filter((root) => root.id > after)
        .map(summary)
        .filter((root): root is CheckpointSummary => root !== undefined)
        .sort((a, b) => {
          if (a.id < b.id) return -1;
          if (a.id > b.id) return 1;
          return 0;
        });
      const checkpoints = rows.slice(0, limit);
      return {
        checkpoints,
        next: rows.length > limit ? checkpoints.at(-1)!.id : null,
      };
    });
  }
  async get(scope: Scope, id: string): Promise<CheckpointSummary | undefined> {
    identifier(id);
    return this.state.transaction((tx) => {
      const sandbox = tx.get<Sandbox>(`sandbox/${scopeKey(scope)}`);
      if (!sandbox) throw Error("Sandbox unavailable");
      const root = this.registry
        .rootsIn(tx, { ...scope, generation: sandbox.generation })
        .find((root) => root.id === id);
      return root ? summary(root) : undefined;
    });
  }
  async pin(
    scope: Scope,
    rootId: string,
    pin: string,
    retain: boolean,
    operationId: string,
  ) {
    identifier(rootId);
    identifier(pin);
    identifier(operationId);
    if (typeof retain !== "boolean") throw Error("Invalid retention flag");
    const input = { rootId, pin, retain };
    // Admission, pin change and success commit in one transaction. A replay returns
    // its recorded outcome; it never undoes a later pin/unpin operation.
    return this.state.transaction((tx) => {
      const sandbox = tx.get<Sandbox>(`sandbox/${scopeKey(scope)}`);
      if (!sandbox) throw Error("Sandbox unavailable");
      const fence = { ...scope, generation: sandbox.generation };
      const operation = this.operations.admitIn(
        tx,
        fence,
        operationId,
        "checkpoint-pin",
        input,
      );
      if (operation.phase === "succeeded") {
        if (canonical(operation.input) !== canonical(input))
          throw Error("Operation conflict");
        return operation;
      }
      const root = this.registry
        .rootsIn(tx, fence)
        .find((root) => root.id === rootId);
      if (!root || !summary(root))
        throw Error("Filesystem checkpoint unavailable");
      if (!this.operations.claimIn(tx, fence, operationId))
        throw Error("Pin operation unresolved");
      this.registry.pinIn(tx, fence, rootId, pin, retain);
      return this.operations.finishIn(tx, fence, operationId, {
        phase: "succeeded",
        result: input,
        error: null,
      });
    });
  }
}
