import { type CheckpointRegistry, type CheckpointRoot } from "./checkpoints.js";
import {
  type CheckpointStore,
  canonical,
  type Fence,
  identifier,
  type ObjectInfo,
  type StateStore,
  scopeKey,
} from "./contracts.js";
import { validateRootPayload } from "./root-payload.js";
import { parseArchive } from "./transfer.js";

export type CheckpointCopyRecord = {
  source: Fence;
  target: Fence;
  id: string;
  sourceRoot: string;
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
  ): Promise<CheckpointCopyRecord> {
    identifier(id);
    identifier(rootId);
    scopeKey(source);
    scopeKey(target);
    if (source.owner !== target.owner || source.sandbox === target.sandbox)
      throw Error("Copy requires distinct same-owner scopes");
    return this.state.transaction((tx) => {
      const key = this.key(target, id),
        prior = tx.get<CheckpointCopyRecord>(key);
      if (prior) {
        if (
          canonical(prior.source) !== canonical(source) ||
          canonical(prior.target) !== canonical(target) ||
          prior.sourceRoot !== rootId
        )
          throw Error("Checkpoint copy identity conflict");
        return prior;
      }
      const root = this.registry
        .rootsIn(tx, source)
        .find((root) => root.id === rootId && root.retiredAt === null);
      if (!root) throw Error("Copy source checkpoint unavailable");
      validateRootPayload(root);
      parseArchive(root.metadata);
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
    });
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
    await this.state.transaction((tx) => {
      const key = this.key(target, id),
        record = tx.get<CheckpointCopyRecord>(key);
      if (!record || canonical(record.target) !== canonical(target))
        throw Error("Checkpoint copy unavailable");
      if (record.phase === "copying")
        tx.put(key, { ...record, cancelRequested: true });
    });
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
          canonical(root.metadata) !== canonical(record.root.metadata)
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
    frameLimit = 2,
  ): Promise<CheckpointCopyRecord> {
    if (!Number.isSafeInteger(frameLimit) || frameLimit < 1 || frameLimit > 16)
      throw Error("Invalid copy batch bound");
    let record = await this.inspect(target, id);
    if (record.phase !== "copying") return record;
    // Publication may have committed before its acknowledgement or copy outcome.
    const published = await this.registry.root(target, id);
    if (published) {
      if (
        canonical(published.frames) !== canonical(record.frames) ||
        canonical(published.metadata) !== canonical(record.root.metadata)
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
      record.root.metadata,
    );
    return this.finish(record, "published");
  }
}
