import {
  type CheckpointContent,
  checkpointContent,
} from "./checkpoint-content.js";
import { copiedCheckpointMetadata } from "./checkpoint-copy-metadata.js";
import { checkpointArchive } from "./checkpoint-layout.js";
import { type CheckpointRegistry, type CheckpointRoot } from "./checkpoints.js";
import {
  type CheckpointStore,
  canonical,
  type Fence,
  identifier,
  type ObjectInfo,
  type StateStore,
  scopeKey,
  type Transaction,
} from "./contracts.js";
import { portableMemoryRoot } from "./portable-memory-root.js";
import { validateRootPayload } from "./root-payload.js";

/** Bound work per controller turn without imposing a timer delay per two objects. */
export const CHECKPOINT_COPY_BATCH_OBJECTS = 16;
export const MAX_CHECKPOINT_COPY_BATCH_OBJECTS = 256;
export function checkpointCopyBatchObjects(
  value = CHECKPOINT_COPY_BATCH_OBJECTS,
) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_CHECKPOINT_COPY_BATCH_OBJECTS
  )
    throw Error("Invalid copy batch bound");
  return value;
}

export type CheckpointCopyRecord = {
  source: Fence;
  target: Fence;
  id: string;
  sourceRoot: string;
  content: CheckpointContent;
  reader: string;
  root: CheckpointRoot;
  frames: ObjectInfo[];
  next: number;
  cancelRequested: boolean;
  phase: "copying" | "published" | "cancelled";
};

/** Durable, bounded same-owner filesystem copy. Independent target objects keep
 * collection scopes separate; no target can outlive another scope's references. */
export class CheckpointCopy {
  constructor(
    private state: StateStore,
    private registry: CheckpointRegistry,
    private objects: CheckpointStore,
  ) {}
  private key(target: Fence, id: string) {
    return `checkpoint-copy/${scopeKey(target)}/${identifier(id)}`;
  }
  async start(
    source: Fence,
    target: Fence,
    id: string,
    rootId: string,
    content: CheckpointContent = "filesystem",
  ): Promise<CheckpointCopyRecord> {
    return this.state.transaction((tx) =>
      this.startIn(tx, source, target, id, rootId, content),
    );
  }
  startIn(
    tx: Transaction,
    source: Fence,
    target: Fence,
    id: string,
    rootId: string,
    content: CheckpointContent = "filesystem",
  ): CheckpointCopyRecord {
    checkpointContent(content);
    identifier(id);
    identifier(rootId);
    scopeKey(source);
    scopeKey(target);
    if (source.owner !== target.owner || source.sandbox === target.sandbox)
      throw Error("Copy requires distinct same-owner scopes");
    {
      const key = this.key(target, id),
        prior = tx.get<CheckpointCopyRecord>(key);
      if (prior) {
        if (
          canonical(prior.source) !== canonical(source) ||
          canonical(prior.target) !== canonical(target) ||
          prior.sourceRoot !== rootId ||
          (prior.content ?? "filesystem") !== content
        )
          throw Error("Checkpoint copy identity conflict");
        return prior;
      }
      const retained = this.registry
        .rootsIn(tx, source)
        .find((root) => root.id === rootId && root.retiredAt === null);
      if (!retained) throw Error("Copy source checkpoint unavailable");
      validateRootPayload(retained);
      checkpointArchive(retained);
      // Filesystem copies deliberately project away RAM; explicit memory forks retain
      // the entire verified graph and rebind its envelope at publication.
      const portable = portableMemoryRoot(retained);
      if (content === "memory" && !portable)
        throw Error("Memory fork requires a portable memory checkpoint");
      const root =
        content === "memory" ? retained : (portable?.filesystem ?? retained);
      if (
        root.frames.some(
          (frame) =>
            frame.owner !== source.owner || frame.sandbox !== source.sandbox,
        )
      )
        throw Error("Copy source object scope mismatch");
      this.registry.initializeIn(tx, target);
      const reader = crypto.randomUUID();
      this.registry.admitIn(tx, source, reader, "reader", rootId);
      this.registry.admitIn(tx, target, id, "writer");
      const record: CheckpointCopyRecord = {
        source,
        target,
        id,
        sourceRoot: rootId,
        content,
        reader,
        root,
        frames: root.frames.map((frame) => ({
          owner: target.owner,
          sandbox: target.sandbox,
          id: crypto.randomUUID(),
          bytes: frame.bytes,
          sha256: frame.sha256,
        })),
        next: 0,
        cancelRequested: false,
        phase: "copying",
      };
      tx.put(key, record);
      return record;
    }
  }
  async inspect(target: Fence, id: string): Promise<CheckpointCopyRecord> {
    return this.state.transaction((tx) => {
      const record = tx.get<CheckpointCopyRecord>(this.key(target, id));
      if (!record || canonical(record.target) !== canonical(target))
        throw Error("Checkpoint copy unavailable");
      return record;
    });
  }
  async cancel(target: Fence, id: string): Promise<void> {
    await this.state.transaction((tx) => this.cancelIn(tx, target, id));
  }
  cancelIn(tx: Transaction, target: Fence, id: string): void {
    const key = this.key(target, id),
      record = tx.get<CheckpointCopyRecord>(key);
    if (!record || canonical(record.target) !== canonical(target))
      throw Error("Checkpoint copy unavailable");
    if (record.phase === "copying")
      tx.put(key, { ...record, cancelRequested: true });
  }
  private metadata(record: CheckpointCopyRecord) {
    return copiedCheckpointMetadata(
      record.root,
      record.target,
      record.id,
      record.frames,
      record.content ?? "filesystem",
    );
  }
  private async finish(
    record: CheckpointCopyRecord,
    phase: "published" | "cancelled",
  ) {
    return this.state.transaction((tx) => {
      const key = this.key(record.target, record.id),
        current = tx.get<CheckpointCopyRecord>(key);
      if (!current) throw Error("Checkpoint copy unavailable");
      if (current.phase !== "copying") return current;
      const root = this.registry
        .rootsIn(tx, record.target)
        .find((root) => root.id === record.id);
      if (root) {
        if (
          canonical(root.frames) !== canonical(record.frames) ||
          canonical(root.metadata) !== canonical(this.metadata(record))
        )
          throw Error("Copied checkpoint identity conflict");
        phase = "published";
      } else if (phase === "published")
        throw Error("Copied checkpoint publication missing");
      this.registry.closeIn(tx, record.source, record.reader);
      this.registry.closeIn(tx, record.target, record.id);
      const next = { ...current, phase };
      tx.put(key, next);
      return next;
    });
  }
  async advance(
    target: Fence,
    id: string,
    frameLimit = CHECKPOINT_COPY_BATCH_OBJECTS,
  ): Promise<CheckpointCopyRecord> {
    checkpointCopyBatchObjects(frameLimit);
    let record = await this.inspect(target, id);
    if (record.phase !== "copying") return record;
    // Publication may have committed before its acknowledgement or copy outcome.
    const published = await this.registry.root(target, id);
    if (published) {
      if (
        canonical(published.frames) !== canonical(record.frames) ||
        canonical(published.metadata) !== canonical(this.metadata(record))
      )
        throw Error("Copied checkpoint identity conflict");
      return this.finish(record, "published");
    }
    for (
      let count = 0;
      count < frameLimit && record.next < record.frames.length;
      count++
    ) {
      if (record.cancelRequested) return this.finish(record, "cancelled");
      const index = record.next,
        source = record.root.frames[index]!;
      let expected = record.frames[index]!;
      let observed = await this.objects.head(expected);
      if (!observed) {
        // A failed put may permanently reserve its identity. Plan a new object
        // before retrying; an eventual old upload is an unreferenced orphan.
        const planned = await this.state.transaction((tx) => {
          const key = this.key(target, id),
            current = tx.get<CheckpointCopyRecord>(key);
          if (!current) throw Error("Checkpoint copy unavailable");
          if (
            current.phase !== "copying" ||
            current.cancelRequested ||
            current.next !== index
          )
            return { record: current, frame: null };
          const frame = { ...current.frames[index]!, id: crypto.randomUUID() };
          const frames = [...current.frames];
          frames[index] = frame;
          const next = { ...current, frames };
          tx.put(key, next);
          return { record: next, frame };
        });
        record = planned.record;
        if (!planned.frame) {
          if (record.phase !== "copying") return record;
          continue;
        }
        expected = planned.frame;
        observed = await this.objects.put(
          expected,
          this.objects.read(source),
          expected,
        );
      }
      if (canonical(observed) !== canonical(expected))
        throw Error("Copied object integrity mismatch");
      record = await this.state.transaction((tx) => {
        const key = this.key(target, id),
          current = tx.get<CheckpointCopyRecord>(key);
        if (!current) throw Error("Checkpoint copy unavailable");
        if (
          current.phase !== "copying" ||
          current.cancelRequested ||
          current.frames[index]?.id !== expected.id
        )
          return current;
        const next = { ...current, next: Math.max(current.next, index + 1) };
        tx.put(key, next);
        return next;
      });
      if (record.phase !== "copying") return record;
    }
    if (record.cancelRequested) return this.finish(record, "cancelled");
    if (record.next < record.frames.length) return record;
    await this.registry.publish(
      target,
      id,
      id,
      record.frames,
      this.metadata(record),
    );
    return this.finish(record, "published");
  }
}
