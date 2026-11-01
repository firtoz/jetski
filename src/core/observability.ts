import type { EventSink, Json, StateStore } from "./contracts.js";

type RecordValue = { [key: string]: Json };
function record(value: Json | undefined): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

/** Best-effort, post-commit observations, never a lifecycle journal or audit log.
 * Lost commit acknowledgements can omit events; durable state remains authoritative.
 * Only allowlisted metadata is emitted, never command inputs, results or errors. */
export function observeLifecycle(
  state: StateStore,
  sink: EventSink,
  now: () => number = Date.now,
): StateStore {
  return {
    async transaction(body) {
      const changes = new Map<
        string,
        { before: Json | undefined; after: Json | undefined }
      >();
      const result = await state.transaction((tx) => {
        // A state adapter may retry the synchronous transaction callback.
        changes.clear();
        const remember = (key: string, after: Json | undefined) => {
          if (!/^(sandbox|operation)\/[^/]+\/[^/]+(?:\/[^/]+)?$/.test(key))
            return;
          const prior = changes.get(key);
          changes.set(key, {
            before: prior ? prior.before : tx.get(key),
            after,
          });
        };
        return body({
          get: (key) => tx.get(key),
          scan: (prefix) => tx.scan(prefix),
          put: (key, value) => {
            remember(key, value);
            tx.put(key, value);
          },
          delete: (key) => {
            remember(key, undefined);
            tx.delete(key);
          },
        });
      });
      for (const [key, change] of changes) {
        try {
          const [kind, owner, sandbox, operationId] = key.split("/");
          if (!owner || !sandbox) continue;
          const before = record(change.before),
            after = record(change.after);
          if (
            !after ||
            typeof after.phase !== "string" ||
            (before?.phase === after.phase &&
              before?.generation === after.generation)
          )
            continue;
          const details: RecordValue = {
            from: typeof before?.phase === "string" ? before.phase : null,
            to: after.phase,
          };
          if (Number.isSafeInteger(after.generation))
            details.generation = after.generation!;
          if (kind === "operation" && operationId) {
            details.operationId = operationId;
            if (typeof after.kind === "string") details.kind = after.kind;
            if (
              typeof after.createdAt === "number" &&
              typeof after.updatedAt === "number"
            )
              details.elapsedMs = Math.max(
                0,
                after.updatedAt - after.createdAt,
              );
          }
          const emitted = sink.emit({
            type: `${kind}.phase`,
            scope: { owner, sandbox },
            at: now(),
            details,
          });
          // JavaScript consumers may supply an async sink despite the void contract.
          void Promise.resolve(emitted).catch(() => {});
        } catch {
          // Telemetry must not turn an acknowledged mutation into a failed request.
        }
      }
      return result;
    },
  };
}
