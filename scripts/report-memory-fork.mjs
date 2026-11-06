import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Read-only, sanitized report: never output viewer URLs, credentials, checkpoint
// bytes, browser nonces or raw operation errors from the private run directory.
const directory = resolve(process.argv[2] ?? "");
if (!process.argv[2])
  throw Error("Usage: node scripts/report-memory-fork.mjs RUN_DIRECTORY");
const read = (name) => readFile(resolve(directory, name), "utf8");
const plan = JSON.parse(await read("plan.json"));
let invalidTiming = false;
try {
  await read("timing-invalid.json");
  invalidTiming = true;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const events = (await read("timeline-private.jsonl"))
  .trim()
  .split("\n")
  .filter(Boolean)
  .map(JSON.parse);
const event = (panel, fragment) =>
  events.find((e) => e.panel === panel && e.message.includes(fragment))
    ?.elapsedMs;
const duration = (start, end) =>
  start === undefined || end === undefined ? null : end - start;
const saveStart = event("source", "Saving and verifying");
const saveEnd = event("source", "RAM + disk durably published");
const prepared = event("source", "Prepared host and cached image ready");
const database = new DatabaseSync(
  resolve(directory, "controller/state.sqlite"),
  { readOnly: true },
);
let rows;
try {
  rows = database
    .prepare("SELECT key, value FROM kv")
    .all()
    .map((row) => ({ key: row.key, value: JSON.parse(row.value) }));
} finally {
  database.close();
}
const roles = new Map([
  [plan.source, "source"],
  ...plan.branches.map((b) => [b.id, b.panel]),
]);
const operations = rows
  .filter(
    (row) => row.key.startsWith("operation/") && roles.has(row.value.sandbox),
  )
  .map(({ value: op }) => ({
    role: roles.get(op.sandbox),
    kind: op.kind,
    phase: op.phase,
    elapsedMs: op.updatedAt - op.createdAt,
  }))
  .filter((op) =>
    ["create", "copy", "suspend", "resume-memory"].includes(op.kind),
  );
const allocations = rows.filter(
  (row) =>
    row.key.startsWith("boat-allocation/") && row.value.owner === plan.owner,
);
const branches = plan.branches.map((b) => {
  const copyStart = event(b.panel, "Copying the same");
  const copyEnd = event(b.panel, "Checkpoint verified");
  const resumeStart = event(b.panel, "Acquiring host");
  const resumeEnd = event(b.panel, "Restored · same JS");
  return {
    role: b.panel,
    copyMs: duration(copyStart, copyEnd),
    resumeAndViewerMs: duration(resumeStart, resumeEnd),
    preparedIdleLowerBoundMs:
      prepared === undefined ? 0 : duration(prepared, resumeStart),
  };
});
let stageRecords = [];
try {
  stageRecords = (await read("stage-timings.jsonl"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const stages = {};
for (const item of stageRecords) {
  if (!stages[item.stage])
    stages[item.stage] = { count: 0, maxMs: 0, errors: 0 };
  const summary = stages[item.stage];
  summary.count++;
  summary.maxMs = Math.max(summary.maxMs, item.elapsedMs);
  if (item.outcome === "error") summary.errors++;
}
const savedRoot = rows
  .filter((row) => row.key.startsWith("checkpoint/"))
  .flatMap((row) => row.value.roots ?? [])
  .find((root) => root.id === plan.suspend);
const memory =
  savedRoot?.metadata?.kind === "filesystem-memory"
    ? savedRoot.metadata.memory
    : undefined;
const memoryObjects = new Map();
for (const file of memory?.files ?? [])
  for (const chunk of file.chunks)
    memoryObjects.set(chunk.object.id, chunk.object);
const completed = events.find(
  (e) => e.panel === "source" && e.phase === "complete",
);
console.log(
  JSON.stringify(
    {
      complete: !!completed,
      configuration: {
        memoryChunkBytes: plan.memoryChunkBytes ?? null,
        restoreConcurrency: plan.restoreConcurrency ?? null,
        binaryReads: plan.binaryReads ?? false,
      },
      nativeMemoryBytes:
        memory?.files.reduce((sum, file) => sum + file.bytes, 0) ?? null,
      storedMemoryBytes: [...memoryObjects.values()].reduce(
        (sum, object) => sum + object.bytes,
        0,
      ),
      memoryObjects: memoryObjects.size,
      validTotalTiming: !invalidTiming,
      totalMs: invalidTiming ? null : (completed?.elapsedMs ?? null),
      preparationMs: prepared ?? null,
      sourceReadyMs: event("source", "Sandbox ready;") ?? null,
      sourceLiveMs: event("source", "Chromium is running") ?? null,
      warmSourceReadyMs: duration(prepared, event("source", "Sandbox ready;")),
      saveMs: duration(saveStart, saveEnd),
      branches,
      sourceResumeAndViewerMs: duration(
        event("source", "Resuming original"),
        event("source", "Original unchanged"),
      ),
      starts: allocations.length,
      retiredAllocations: allocations.filter((row) => row.value.retired).length,
      operations,
      stages,
      note: "Preparation is included in total. Stage maxima overlap; do not sum. Prepared idle is a lower bound. This report is not provider-absence proof.",
    },
    null,
    2,
  ),
);
