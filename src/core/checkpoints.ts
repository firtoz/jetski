import {
  type CheckpointStore,
  canonical,
  DEFAULTS,
  type Fence,
  identifier,
  type Json,
  type ObjectInfo,
  type Scope,
  type StateStore,
  scopeKey,
  type Transaction,
} from "./contracts.js";

export type CheckpointRoot = {
  id: string;
  frames: ObjectInfo[];
  metadata: Json;
  publishedAt: number;
  retiredAt: number | null;
  pins: string[];
};
type FrameSave = {
  generation: number;
  metadata: Json;
  expected: Array<{ bytes: number; sha256: string }>;
  frames: Record<string, ObjectInfo>;
};
type Access = {
  id: string;
  kind: "reader" | "writer";
  root: string | null;
  generation: number;
};
type Registry = {
  generation: number;
  accesses: Access[];
  roots: CheckpointRoot[];
  collection: string | null;
};

/** Fails closed on leaked admissions. Recovery must establish that an old actor
 * cannot continue before advancing its generation. A collector excludes all new
 * readers and writers for its entire sweep, including after process restart. */
export class CheckpointRegistry {
  constructor(
    private readonly state: StateStore,
    private readonly objects: CheckpointStore,
    private readonly now = Date.now,
  ) {}
  private key(scope: Scope) {
    return `checkpoint/${scopeKey(scope)}`;
  }
  private load(tx: Transaction, fence: Fence): Registry {
    const state = tx.get<Registry>(this.key(fence));
    if (!state || state.generation !== fence.generation)
      throw new Error("Checkpoint generation mismatch");
    return state;
  }
  /** Caller must prove the old host assignment is released before advancing. */
  advanceIn(tx: Transaction, fence: Fence): Fence {
    const state = this.load(tx, fence);
    if (state.accesses.length || state.collection)
      throw Error("Checkpoint actors still active");
    const generation = fence.generation + 1;
    if (!Number.isSafeInteger(generation)) throw Error("Generation exhausted");
    tx.put(this.key(fence), { ...state, generation });
    return { ...fence, generation };
  }
  async initialize(fence: Fence): Promise<void> {
    await this.state.transaction((tx) => {
      if (tx.get(this.key(fence))) {
        this.load(tx, fence);
        return;
      }
      if (!Number.isSafeInteger(fence.generation) || fence.generation < 1)
        throw new Error("Invalid generation");
      tx.put(this.key(fence), {
        generation: fence.generation,
        accesses: [],
        roots: [],
        collection: null,
      });
    });
  }
  async admit(
    fence: Fence,
    id: string,
    kind: Access["kind"],
    root: string | null = null,
  ): Promise<void> {
    identifier(id);
    await this.state.transaction((tx) => {
      const state = this.load(tx, fence);
      if (state.collection) throw new Error("Collection in progress");
      const usedKey = `checkpoint-access/${scopeKey(fence)}/${id}`;
      if (tx.get(usedKey)) throw new Error("Admission already exists");
      if (
        kind === "reader" &&
        !state.roots.some((item) => item.id === root && item.retiredAt === null)
      )
        throw new Error("Root unavailable");
      if (state.accesses.length >= 64) throw new Error("Admission limit");
      tx.put(usedKey, true);
      state.accesses.push({ id, kind, root, generation: fence.generation });
      tx.put(this.key(fence), state);
    });
  }
  async close(fence: Fence, id: string): Promise<void> {
    await this.state.transaction((tx) => {
      const state = this.load(tx, fence);
      state.accesses = state.accesses.filter((access) => access.id !== id);
      tx.put(this.key(fence), state);
    });
  }
  async publish(
    fence: Fence,
    writer: string,
    rootId: string,
    frames: ObjectInfo[],
    metadata: Json = null,
  ): Promise<void> {
    identifier(rootId);
    if (frames.length > 16384) throw new Error("Manifest bound exceeded");
    const frozen = structuredClone(frames);
    await this.state.transaction((tx) => {
      const state = this.load(tx, fence);
      if (
        state.collection ||
        !state.accesses.some(
          (access) => access.id === writer && access.kind === "writer",
        )
      )
        throw new Error("Writer not admitted");
    });
    for (const frame of frozen) {
      if (frame.owner !== fence.owner || frame.sandbox !== fence.sandbox)
        throw new Error("Cross-owner frame");
      const verified = await this.objects.head(frame);
      if (
        !verified ||
        verified.sha256 !== frame.sha256 ||
        verified.bytes !== frame.bytes
      )
        throw new Error("Publication integrity failure");
    }
    await this.state.transaction((tx) => {
      const state = this.load(tx, fence);
      if (
        state.collection ||
        !state.accesses.some(
          (access) => access.id === writer && access.kind === "writer",
        )
      )
        throw new Error("Writer no longer admitted");
      if (state.roots.some((root) => root.id === rootId))
        throw new Error("Root identity already exists");
      state.roots.push({
        id: rootId,
        frames: frozen,
        metadata: structuredClone(metadata),
        publishedAt: this.now(),
        retiredAt: null,
        pins: [],
      });
      state.accesses = state.accesses.filter((access) => access.id !== writer);
      tx.put(this.key(fence), state);
    });
  }
  async beginFrameSave(
    fence: Fence,
    id: string,
    metadata: Json,
    expected: Array<{ bytes: number; sha256: string }>,
  ): Promise<Record<string, ObjectInfo>> {
    identifier(id);
    if (
      expected.length < 1 ||
      expected.length > 8192 ||
      expected.some(
        (frame) =>
          !Number.isSafeInteger(frame.bytes) ||
          frame.bytes < 1 ||
          frame.bytes > DEFAULTS.maxObjectBytes ||
          !/^[a-f0-9]{64}$/.test(frame.sha256),
      )
    )
      throw Error("Frame journal bound or integrity descriptor");
    return this.state.transaction((tx) => {
      const state = this.load(tx, fence),
        key = `frame-save/${scopeKey(fence)}/${id}`;
      const previous = tx.get<FrameSave>(key);
      if (previous) {
        if (
          previous.generation !== fence.generation ||
          canonical(previous.metadata) !== canonical(metadata) ||
          canonical(previous.expected) !== canonical(expected)
        )
          throw Error("Checkpoint operation identity conflict");
        if (
          state.collection ||
          !state.accesses.some(
            (access) => access.id === id && access.kind === "writer",
          )
        )
          throw Error("Frame writer no longer admitted");
        return previous.frames;
      }
      const used = `checkpoint-access/${scopeKey(fence)}/${id}`;
      if (state.collection || tx.get(used) || state.accesses.length >= 64)
        throw Error("Frame writer cannot be admitted");
      tx.put(used, true);
      state.accesses.push({
        id,
        kind: "writer",
        root: null,
        generation: fence.generation,
      });
      tx.put(this.key(fence), state);
      tx.put(key, {
        generation: fence.generation,
        metadata,
        expected,
        frames: {},
      });
      return {};
    });
  }
  /** Persist immutable upload identity before I/O. A retry first verifies that
   * identity, recovering a completed upload even when its acknowledgement was lost. */
  async planFrame(
    fence: Fence,
    id: string,
    index: number,
    object: ObjectInfo,
  ): Promise<void> {
    await this.state.transaction((tx) => {
      const state = this.load(tx, fence),
        key = `frame-save/${scopeKey(fence)}/${id}`;
      const journal = tx.get<FrameSave>(key),
        expected = journal?.expected[index];
      if (
        !journal ||
        journal.generation !== fence.generation ||
        !Number.isSafeInteger(index) ||
        !expected ||
        state.collection ||
        !state.accesses.some(
          (access) => access.id === id && access.kind === "writer",
        )
      )
        throw Error("Frame writer not admitted");
      if (
        object.owner !== fence.owner ||
        object.sandbox !== fence.sandbox ||
        object.bytes !== expected.bytes ||
        object.sha256 !== expected.sha256
      )
        throw Error("Frame journal integrity conflict");
      identifier(object.id);
      journal.frames[String(index)] = object;
      tx.put(key, journal);
    });
  }
  async pin(
    fence: Fence,
    rootId: string,
    pin: string,
    retain: boolean,
  ): Promise<void> {
    identifier(pin);
    await this.state.transaction((tx) => {
      const state = this.load(tx, fence);
      if (state.collection) throw new Error("Collection in progress");
      const root = state.roots.find(
        (root) => root.id === rootId && root.retiredAt === null,
      );
      if (!root) throw new Error("Root unavailable");
      root.pins = root.pins.filter((value) => value !== pin);
      if (retain) root.pins.push(pin);
      tx.put(this.key(fence), state);
    });
  }
  /** Retirement is explicit; acknowledged history never expires automatically. */
  async retire(fence: Fence, rootId: string): Promise<void> {
    await this.state.transaction((tx) => {
      const state = this.load(tx, fence);
      if (state.collection) throw new Error("Collection in progress");
      const root = state.roots.find((root) => root.id === rootId);
      if (
        !root ||
        root.pins.length ||
        state.accesses.some((access) => access.root === rootId)
      )
        throw new Error("Root protected or unavailable");
      root.retiredAt ??= this.now();
      tx.put(this.key(fence), state);
    });
  }
  /** Scoped known-frame collection only. Unknown orphan collection needs a separate
   * complete object inventory journal and is intentionally not enabled here. */
  async collect(
    fence: Fence,
    collection: string,
  ): Promise<{ deleted: number }> {
    identifier(collection);
    const snapshot = await this.state.transaction((tx) => {
      const state = this.load(tx, fence);
      if (state.accesses.length) throw new Error("Active readers or writers");
      if (state.collection && state.collection !== collection)
        throw new Error("Different collection in progress");
      state.collection = collection;
      tx.put(this.key(fence), state);
      return state;
    });
    const cutoff = this.now() - DEFAULTS.gcGraceMs;
    const live = new Map<string, ObjectInfo>();
    const candidates = new Map<string, ObjectInfo>();
    for (const root of snapshot.roots) {
      const protectedRoot =
        root.retiredAt === null ||
        root.retiredAt > cutoff ||
        root.pins.length > 0;
      for (const frame of root.frames) {
        if (frame.owner !== fence.owner || frame.sandbox !== fence.sandbox)
          throw new Error("Ambiguous owner metadata");
        if (protectedRoot) live.set(frame.id, frame);
        else candidates.set(frame.id, frame);
      }
    }
    // Complete retained reachability verification precedes the first delete.
    for (const frame of live.values()) {
      const actual = await this.objects.head(frame);
      if (
        !actual ||
        actual.sha256 !== frame.sha256 ||
        actual.bytes !== frame.bytes
      )
        throw new Error("Retained root integrity failure");
    }
    let deleted = 0;
    for (const frame of candidates.values()) {
      if (live.has(frame.id)) continue;
      await this.objects.delete(frame);
      deleted++;
    }
    await this.state.transaction((tx) => {
      const state = this.load(tx, fence);
      if (state.collection !== collection) throw new Error("Collector fenced");
      state.collection = null;
      tx.put(this.key(fence), state);
    });
    return { deleted };
  }
  async root(fence: Fence, id: string): Promise<CheckpointRoot | undefined> {
    return this.state.transaction((tx) =>
      this.load(tx, fence).roots.find(
        (root) => root.id === id && root.retiredAt === null,
      ),
    );
  }
  async inspect(scope: Scope): Promise<Json | undefined> {
    return this.state.transaction((tx) => tx.get(this.key(scope)));
  }
}
