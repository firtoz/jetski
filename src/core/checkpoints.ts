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
import {
  inventoryObjects,
  type ObjectObservation,
  observationKey,
  sameObject,
  validObservation,
} from "./inventory.js";
import { validateRootPayload } from "./root-payload.js";

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
export type StreamPart = {
  bytes: number;
  sha256: string;
  nextOffset: number;
  terminal: boolean;
  object: ObjectInfo | null;
};
type StreamSave = {
  generation: number;
  input: Json;
  parts: Record<string, StreamPart>;
};
type Access = {
  id: string;
  kind: "reader" | "writer";
  root: string | null;
  generation: number;
};
type CollectionJournal = {
  generation: number;
  candidates: ObjectInfo[];
  next: number;
  done: boolean;
};

type Registry = {
  generation: number;
  accesses: Access[];
  roots: CheckpointRoot[];
  collection: string | null;
};

/** Persisted JSON is untrusted at the deletion boundary. Validate every root,
 * including retired roots, before computing reachability or calling storage. */
function validateCollectionState(state: Registry, fence: Fence): void {
  const invalid = () => {
    throw Error("Ambiguous checkpoint metadata");
  };
  const validId = (value: unknown): value is string =>
    typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
  const timestamp = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (
    Object.keys(state).sort().join(",") !==
      "accesses,collection,generation,roots" ||
    !Number.isSafeInteger(state.generation) ||
    state.generation < 1 ||
    !Array.isArray(state.accesses) ||
    !Array.isArray(state.roots) ||
    !(state.collection === null || validId(state.collection))
  )
    invalid();
  const roots = new Set<string>();
  const frames = new Map<string, ObjectInfo>();
  for (const root of state.roots) {
    if (
      !root ||
      typeof root !== "object" ||
      Object.keys(root).sort().join(",") !==
        "frames,id,metadata,pins,publishedAt,retiredAt" ||
      !validId(root.id) ||
      roots.has(root.id) ||
      !timestamp(root.publishedAt) ||
      !(
        root.retiredAt === null ||
        (timestamp(root.retiredAt) && root.retiredAt >= root.publishedAt)
      ) ||
      !Array.isArray(root.pins) ||
      root.pins.length > 128 ||
      root.pins.some((pin) => !validId(pin)) ||
      new Set(root.pins).size !== root.pins.length ||
      !Array.isArray(root.frames) ||
      root.frames.length > 16384
    )
      invalid();
    validateRootPayload(root);
    roots.add(root.id);
    for (const frame of root.frames) {
      if (
        !frame ||
        typeof frame !== "object" ||
        !validId(frame.id) ||
        frame.owner !== fence.owner ||
        frame.sandbox !== fence.sandbox ||
        !Number.isSafeInteger(frame.bytes) ||
        frame.bytes < 0 ||
        frame.bytes > DEFAULTS.maxObjectBytes ||
        typeof frame.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(frame.sha256)
      )
        invalid();
      const prior = frames.get(frame.id);
      if (
        prior &&
        (prior.bytes !== frame.bytes || prior.sha256 !== frame.sha256)
      )
        invalid();
      frames.set(frame.id, frame);
    }
  }
  const accesses = new Set<string>();
  for (const access of state.accesses) {
    if (
      !access ||
      !validId(access.id) ||
      accesses.has(access.id) ||
      access.generation !== state.generation ||
      !(access.kind === "reader" || access.kind === "writer") ||
      (access.kind === "reader" &&
        (!validId(access.root) || !roots.has(access.root))) ||
      (access.kind === "writer" && access.root !== null)
    )
      invalid();
    accesses.add(access.id);
  }
}

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
    await this.state.transaction((tx) => this.initializeIn(tx, fence));
  }
  initializeIn(tx: Transaction, fence: Fence): void {
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
  }
  async admit(
    fence: Fence,
    id: string,
    kind: Access["kind"],
    root: string | null = null,
  ): Promise<void> {
    await this.state.transaction((tx) =>
      this.admitIn(tx, fence, id, kind, root),
    );
  }
  admitIn(
    tx: Transaction,
    fence: Fence,
    id: string,
    kind: Access["kind"],
    root: string | null = null,
  ): void {
    identifier(id);
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
  }
  async close(fence: Fence, id: string): Promise<void> {
    await this.state.transaction((tx) => this.closeIn(tx, fence, id));
  }
  closeIn(tx: Transaction, fence: Fence, id: string): void {
    const state = this.load(tx, fence);
    state.accesses = state.accesses.filter((access) => access.id !== id);
    tx.put(this.key(fence), state);
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
    const frozenMetadata = structuredClone(metadata);
    validateRootPayload({
      id: rootId,
      frames: frozen,
      metadata: frozenMetadata,
      publishedAt: 0,
      retiredAt: null,
      pins: [],
    });
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
        metadata: frozenMetadata,
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
  async beginStreamSave(
    fence: Fence,
    id: string,
    input: Json,
  ): Promise<Record<string, StreamPart>> {
    identifier(id);
    return this.state.transaction((tx) => {
      const state = this.load(tx, fence),
        key = `stream-save/${scopeKey(fence)}/${id}`;
      const previous = tx.get<StreamSave>(key);
      if (previous) {
        if (
          previous.generation !== fence.generation ||
          canonical(previous.input) !== canonical(input)
        )
          throw Error("Stream save identity conflict");
        if (
          state.collection ||
          !state.accesses.some(
            (access) => access.id === id && access.kind === "writer",
          )
        )
          throw Error("Stream writer no longer admitted");
        return previous.parts;
      }
      const used = `checkpoint-access/${scopeKey(fence)}/${id}`;
      if (state.collection || tx.get(used) || state.accesses.length >= 64)
        throw Error("Stream writer cannot be admitted");
      tx.put(used, true);
      state.accesses.push({
        id,
        kind: "writer",
        root: null,
        generation: fence.generation,
      });
      tx.put(this.key(fence), state);
      tx.put(key, { generation: fence.generation, input, parts: {} });
      return {};
    });
  }
  async planStreamPart(
    fence: Fence,
    id: string,
    partId: string,
    part: StreamPart,
  ): Promise<void> {
    identifier(partId);
    if (
      !Number.isSafeInteger(part.bytes) ||
      part.bytes < 0 ||
      part.bytes > DEFAULTS.outputChunkBytes ||
      !Number.isSafeInteger(part.nextOffset) ||
      part.nextOffset < part.bytes ||
      part.nextOffset > DEFAULTS.outputChannelBytes ||
      typeof part.terminal !== "boolean" ||
      !/^[a-f0-9]{64}$/.test(part.sha256)
    )
      throw Error("Invalid stream part");
    if (part.object) {
      identifier(part.object.id);
      if (
        part.object.owner !== fence.owner ||
        part.object.sandbox !== fence.sandbox ||
        part.object.bytes !== part.bytes ||
        part.object.sha256 !== part.sha256 ||
        part.bytes === 0
      )
        throw Error("Invalid stream object");
    } else if (part.bytes !== 0 || !part.terminal)
      throw Error("Missing stream object");
    await this.state.transaction((tx) => {
      const state = this.load(tx, fence),
        key = `stream-save/${scopeKey(fence)}/${id}`;
      const journal = tx.get<StreamSave>(key);
      if (
        !journal ||
        journal.generation !== fence.generation ||
        state.collection ||
        !state.accesses.some(
          (access) => access.id === id && access.kind === "writer",
        )
      )
        throw Error("Stream writer not admitted");
      const prior = journal.parts[partId];
      if (
        prior &&
        canonical({ ...prior, object: null }) !==
          canonical({ ...part, object: null })
      )
        throw Error("Stream content changed");
      if (
        !prior &&
        Object.keys(journal.parts).length >= DEFAULTS.outputJournalParts
      )
        throw Error("Stream journal bound");
      journal.parts[partId] = part;
      tx.put(key, journal);
    });
  }
  async pin(
    fence: Fence,
    rootId: string,
    pin: string,
    retain: boolean,
  ): Promise<void> {
    await this.state.transaction((tx) =>
      this.pinIn(tx, fence, rootId, pin, retain),
    );
  }
  pinIn(
    tx: Transaction,
    fence: Fence,
    rootId: string,
    pin: string,
    retain: boolean,
  ): void {
    identifier(pin);
    const state = this.load(tx, fence);
    if (state.collection) throw new Error("Collection in progress");
    const root = state.roots.find(
      (root) => root.id === rootId && root.retiredAt === null,
    );
    if (!root) throw new Error("Root unavailable");
    if (retain && !root.pins.includes(pin) && root.pins.length >= 128)
      throw Error("Pin limit reached");
    root.pins = root.pins.filter((value) => value !== pin);
    if (retain) root.pins.push(pin);
    tx.put(this.key(fence), state);
  }
  rootsIn(tx: Transaction, fence: Fence): CheckpointRoot[] {
    return this.load(tx, fence).roots;
  }
  /** Internal lifecycle reference, distinct from user-removable retention pins. */
  holdIn(tx: Transaction, fence: Fence, id: string, rootId: string): void {
    identifier(id);
    identifier(rootId);
    const state = this.load(tx, fence);
    if (state.collection) throw Error("Collection in progress");
    if (
      !state.roots.some((root) => root.id === rootId && root.retiredAt === null)
    )
      throw Error("Root unavailable");
    const key = `checkpoint-reference/${scopeKey(fence)}/${id}`;
    const prior = tx.get<{ rootId: string }>(key);
    if (prior && prior.rootId !== rootId)
      throw Error("Checkpoint reference conflict");
    tx.put(key, { rootId });
  }
  releaseIn(tx: Transaction, fence: Fence, id: string): void {
    this.load(tx, fence);
    identifier(id);
    tx.delete(`checkpoint-reference/${scopeKey(fence)}/${id}`);
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
        tx
          .scan<{ rootId: string }>(`checkpoint-reference/${scopeKey(fence)}/`)
          .some((row) => row.value.rootId === rootId) ||
        state.accesses.some((access) => access.root === rootId)
      )
        throw new Error("Root protected or unavailable");
      root.retiredAt ??= this.now();
      tx.put(this.key(fence), state);
    });
  }
  /** Scoped collection requires complete inventory, retained reachability and
   * durable grace observations. Incomplete enumeration cannot authorize deletion. */
  async collect(
    fence: Fence,
    collection: string,
  ): Promise<{ deleted: number }> {
    identifier(collection);
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0)
      throw Error("Invalid collection clock");
    const journalKey = `checkpoint-collection/${scopeKey(fence)}/${collection}`;
    const completed = await this.state.transaction((tx) => {
      const state = this.load(tx, fence);
      validateCollectionState(state, fence);
      const journal = tx.get<CollectionJournal>(journalKey);
      if (
        journal &&
        (Object.keys(journal).sort().join(",") !==
          "candidates,done,generation,next" ||
          !Array.isArray(journal.candidates) ||
          typeof journal.done !== "boolean" ||
          !Number.isSafeInteger(journal.next) ||
          journal.next < 0 ||
          journal.next > journal.candidates.length ||
          (journal.done && journal.next !== journal.candidates.length) ||
          journal.candidates.some(
            (frame) =>
              !frame ||
              (!state.roots.some((root) =>
                root.frames.some((known) => sameObject(known, frame)),
              ) &&
                !validObservation(
                  tx.get<ObjectObservation>(observationKey(fence, frame.id))!,
                  frame,
                )),
          ) ||
          new Set(journal.candidates.map((frame) => frame.id)).size !==
            journal.candidates.length)
      )
        throw Error("Ambiguous collection journal");
      if (journal && journal.generation !== fence.generation)
        throw Error("Collector generation mismatch");
      return journal?.done ? journal.candidates.length : undefined;
    });
    if (completed !== undefined) return { deleted: completed };
    const snapshot = await this.state.transaction((tx) => {
      const state = this.load(tx, fence);
      validateCollectionState(state, fence);
      if (state.accesses.length) throw new Error("Active readers or writers");
      if (tx.scan(`checkpoint-reference/${scopeKey(fence)}/`).length)
        throw Error("Active checkpoint references");
      if (state.collection && state.collection !== collection)
        throw new Error("Different collection in progress");
      state.collection = collection;
      tx.put(this.key(fence), state);
      return state;
    });
    const cutoff = now - DEFAULTS.gcGraceMs;
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
    const inventory = await inventoryObjects(
      this.state,
      this.objects,
      fence,
      collection,
      now,
      (tx) => {
        const current = this.load(tx, fence);
        if (
          current.collection !== collection ||
          current.accesses.length ||
          tx.scan(`checkpoint-reference/${scopeKey(fence)}/`).length
        )
          throw Error("Collector fenced");
      },
    );
    const known = new Map([...candidates, ...live]);
    for (const frame of known.values()) {
      if (!inventory.has(frame.id) && (await this.objects.head(frame)))
        throw Error("Incomplete inventory omitted a known object");
    }
    for (const row of inventory.values()) {
      const referenced = known.get(row.object.id);
      if (referenced && !sameObject(referenced, row.object))
        throw Error("Inventory root integrity failure");
      if (!referenced && row.firstSeen <= cutoff)
        candidates.set(row.object.id, row.object);
    }
    // A deletion may have succeeded just before its acknowledgement was lost.
    // Preserve the original plan for absent objects; immutable IDs cannot recur.
    await this.state.transaction((tx) => {
      const prior = tx.get<CollectionJournal>(journalKey);
      for (const object of prior?.candidates ?? []) {
        if (known.has(object.id) || inventory.has(object.id)) continue;
        const row = tx.get<ObjectObservation>(observationKey(fence, object.id));
        if (!row || !validObservation(row, object) || row.firstSeen > cutoff)
          throw Error("Ambiguous orphan collection journal");
        candidates.set(object.id, object);
      }
    });
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
    const planned = [...candidates.values()].filter(
      (frame) => !live.has(frame.id),
    );
    const journal = await this.state.transaction((tx) => {
      const state = this.load(tx, fence);
      if (state.collection !== collection) throw Error("Collector fenced");
      const prior = tx.get<CollectionJournal>(journalKey);
      if (prior) {
        // A later retry's clock may admit additional retired frames. Its plan is
        // deliberately ignored: this identity retains the original candidate set.
        if (
          prior.generation !== fence.generation ||
          !Array.isArray(prior.candidates) ||
          !Number.isSafeInteger(prior.next) ||
          prior.next < 0 ||
          prior.next > prior.candidates.length ||
          prior.done !== false ||
          new Set(prior.candidates.map((frame) => frame.id)).size !==
            prior.candidates.length ||
          prior.candidates.some(
            (frame) =>
              !planned.some(
                (candidate) => canonical(candidate) === canonical(frame),
              ),
          )
        )
          throw Error("Ambiguous collection journal");
        return prior;
      }
      const created: CollectionJournal = {
        generation: fence.generation,
        candidates: planned,
        next: 0,
        done: false,
      };
      tx.put(journalKey, created);
      return created;
    });
    for (let index = journal.next; index < journal.candidates.length; index++) {
      // A lost deletion acknowledgement retries this same immutable identity.
      // Stores must make deletion idempotent and must never reuse object IDs.
      await this.state.transaction((tx) => {
        const state = this.load(tx, fence);
        const current = tx.get<CollectionJournal>(journalKey);
        if (
          state.collection !== collection ||
          !current ||
          current.generation !== fence.generation ||
          current.done ||
          current.next !== index ||
          !sameObject(current.candidates[index]!, journal.candidates[index]!)
        )
          throw Error("Collector fenced");
      });
      await this.objects.delete(journal.candidates[index]!);
      await this.state.transaction((tx) => {
        const state = this.load(tx, fence);
        const current = tx.get<CollectionJournal>(journalKey);
        if (
          state.collection !== collection ||
          !current ||
          current.generation !== fence.generation ||
          current.done ||
          current.next !== index
        )
          throw Error("Collector fenced");
        tx.put(journalKey, { ...current, next: index + 1 });
      });
    }
    await this.state.transaction((tx) => {
      const state = this.load(tx, fence);
      const current = tx.get<CollectionJournal>(journalKey);
      if (
        state.collection !== collection ||
        !current ||
        current.next !== current.candidates.length
      )
        throw new Error("Collector fenced");
      tx.put(journalKey, { ...current, done: true });
      state.collection = null;
      tx.put(this.key(fence), state);
    });
    return { deleted: journal.candidates.length };
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
