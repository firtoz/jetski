import type { CheckpointStore } from "./contracts.js";

/** Best-effort monotonic durations, not durable receipts. Nested/overlapping
 * spans must not be added together. Contains no paths, arguments or credentials. */
export type StageTiming = {
  stage: string;
  elapsedMs: number;
  outcome: "ok" | "error" | "observed";
};
export type StageTimingSink = (timing: StageTiming) => void;
export function emitTiming(sink: StageTimingSink, timing: StageTiming): void {
  try {
    // Also contain rejection from a JavaScript consumer's accidental async sink.
    void Promise.resolve(sink(timing)).catch(() => {});
  } catch {
    // Never turn successful work into uncertain work because diagnostics failed.
  }
}
export async function timeStage<T>(
  sink: StageTimingSink | undefined,
  stage: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!sink) return run();
  const started = performance.now();
  let outcome: StageTiming["outcome"] = "error";
  try {
    const result = await run();
    outcome = "ok";
    return result;
  } finally {
    emitTiming(sink, {
      stage,
      elapsedMs: performance.now() - started,
      outcome,
    });
  }
}
async function* timedStream<T>(
  sink: StageTimingSink,
  stage: string,
  source: AsyncIterable<T>,
): AsyncIterable<T> {
  const started = performance.now();
  let outcome: StageTiming["outcome"] = "error";
  try {
    yield* source;
    outcome = "ok";
  } finally {
    // Early consumer closure is not a successful full read.
    emitTiming(sink, {
      stage,
      elapsedMs: performance.now() - started,
      outcome,
    });
  }
}
/** Wrap any store without loading filesystem/provider modules. Streaming duration
 * includes consumer backpressure; read creation does not consume the source. */
export function observeCheckpointStore(
  store: CheckpointStore,
  sink: StageTimingSink,
): CheckpointStore {
  return {
    ...(store.verificationConcurrency !== undefined
      ? { verificationConcurrency: store.verificationConcurrency }
      : {}),
    ...(store.transferConcurrency !== undefined
      ? { transferConcurrency: store.transferConcurrency }
      : {}),
    put: (...args) => timeStage(sink, "storage.put", () => store.put(...args)),
    head: (...args) =>
      timeStage(sink, "storage.head", () => store.head(...args)),
    delete: (...args) =>
      timeStage(sink, "storage.delete", () => store.delete(...args)),
    read: (...args) => timedStream(sink, "storage.read", store.read(...args)),
    list: (...args) => timedStream(sink, "storage.list", store.list(...args)),
    ...(store.putBuffer
      ? {
          putBuffer: (
            ...args: Parameters<NonNullable<CheckpointStore["putBuffer"]>>
          ) =>
            timeStage(sink, "storage.putBuffer", () =>
              store.putBuffer!(...args),
            ),
        }
      : {}),
    ...(store.verifyRanges
      ? {
          verifyRanges: (
            ...args: Parameters<NonNullable<CheckpointStore["verifyRanges"]>>
          ) =>
            timeStage(sink, "storage.verifyRanges", () =>
              store.verifyRanges!(...args),
            ),
        }
      : {}),
  };
}
/** Bounded allowlisted stderr observations. Untrusted/malformed diagnostics can
 * never become lifecycle success or leak arbitrary host stderr into an event. */
export function observeHostTimings(
  stderr: string,
  sink: StageTimingSink,
): void {
  let count = 0;
  for (const line of stderr.slice(0, 64 * 1024).split("\n")) {
    if (!line.startsWith("JETSKI-STAGE/1:") || ++count > 64) continue;
    try {
      const value = JSON.parse(line.slice("JETSKI-STAGE/1:".length));
      if (
        ![
          "archive.capture",
          "archive.restore",
          "archive.extract",
          "archive.sync_publish",
          "runtime.create",
          "cache.publish",
        ].includes(value?.stage) ||
        typeof value.elapsedMs !== "number" ||
        !Number.isFinite(value.elapsedMs) ||
        value.elapsedMs < 0 ||
        value.elapsedMs > 600_000 ||
        !["ok", "error", "observed"].includes(value.outcome)
      )
        continue;
      emitTiming(sink, {
        stage: value.stage,
        elapsedMs: value.elapsedMs,
        outcome: value.outcome,
      });
    } catch {
      /* Missing diagnostics are not lifecycle failures. */
    }
  }
}
