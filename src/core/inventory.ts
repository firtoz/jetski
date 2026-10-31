import {
  type CheckpointStore,
  DEFAULTS,
  type Fence,
  identifier,
  type ObjectInfo,
  type StateStore,
  scopeKey,
  type Transaction,
} from "./contracts.js";

export type ObjectObservation = { object: ObjectInfo; firstSeen: number };
export function observationKey(fence: Fence, id: string): string {
  return `checkpoint-object/${scopeKey(fence)}/${identifier(id)}`;
}
export function sameObject(a: ObjectInfo, b: ObjectInfo): boolean {
  return (
    a.owner === b.owner &&
    a.sandbox === b.sandbox &&
    a.id === b.id &&
    a.bytes === b.bytes &&
    a.sha256 === b.sha256
  );
}
export function validObservation(
  value: ObjectObservation,
  object: ObjectInfo,
): boolean {
  return (
    !!value &&
    !!value.object &&
    sameObject(value.object, object) &&
    Number.isSafeInteger(value.firstSeen) &&
    value.firstSeen >= 0
  );
}

/** Each attempt enumerates from the beginning. Partial pages are diagnostic only:
 * no caller receives candidates until the complete listing has been validated. */
export async function inventoryObjects(
  state: StateStore,
  store: CheckpointStore,
  fence: Fence,
  collection: string,
  now: number,
  check: (tx: Transaction) => void,
): Promise<Map<string, ObjectObservation>> {
  const key = `checkpoint-inventory/${scopeKey(fence)}/${identifier(collection)}`;
  const attempt = crypto.randomUUID();
  await state.transaction((tx) => {
    check(tx);
    tx.put(key, {
      attempt,
      generation: fence.generation,
      complete: false,
      pages: 0,
      objects: 0,
    });
  });
  const result = new Map<string, ObjectObservation>();
  let page: ObjectInfo[] = [],
    pages = 0;
  const flush = async () => {
    if (!page.length) return;
    const observed = await state.transaction((tx) => {
      check(tx);
      const active = tx.get<{ attempt: string }>(key);
      if (active?.attempt !== attempt) throw Error("Inventory attempt fenced");
      const rows = page.map((object) => {
        const objectKey = observationKey(fence, object.id);
        let row = tx.get<ObjectObservation>(objectKey);
        if (row && !validObservation(row, object))
          throw Error("Ambiguous object observation");
        row ??= { object, firstSeen: now };
        tx.put(objectKey, row);
        return row;
      });
      tx.put(`${key}/page/${pages}`, page);
      tx.put(key, {
        attempt,
        generation: fence.generation,
        complete: false,
        pages: pages + 1,
        objects: result.size + rows.length,
      });
      return rows;
    });
    for (const row of observed) result.set(row.object.id, row);
    pages++;
    page = [];
  };
  const seen = new Set<string>();
  for await (const object of store.list(fence)) {
    if (
      !object ||
      object.owner !== fence.owner ||
      object.sandbox !== fence.sandbox ||
      typeof object.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(object.id) ||
      !Number.isSafeInteger(object.bytes) ||
      object.bytes < 0 ||
      object.bytes > DEFAULTS.maxObjectBytes ||
      typeof object.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(object.sha256) ||
      seen.has(object.id)
    )
      throw Error("Ambiguous object inventory");
    seen.add(object.id);
    if (seen.size > DEFAULTS.gcInventoryObjects)
      throw Error("Inventory object bound exceeded");
    page.push(structuredClone(object));
    if (page.length === DEFAULTS.gcInventoryPageObjects) await flush();
  }
  await flush();
  await state.transaction((tx) => {
    check(tx);
    if (tx.get<{ attempt: string }>(key)?.attempt !== attempt)
      throw Error("Inventory attempt fenced");
    tx.put(key, {
      attempt,
      generation: fence.generation,
      complete: true,
      pages,
      objects: result.size,
    });
  });
  return result;
}
