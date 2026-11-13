import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GVISOR_RUNTIME, memoryRestoreConcurrency } from "@firtoz/jetski/core";
import { openJetski } from "@firtoz/jetski/node";
import { openDesktopGateway } from "./access.js";
import { assertSameBrowserState, chromiumState } from "./chromium.js";
import { installDesktop } from "./install.js";
import { recordDashboard } from "./record.js";
import { openTimeline, type Panel } from "./timeline.js";

const directory = resolve(
  process.env.JETSKI_DEMO_DIRECTORY ?? ".jetski-memory-fork",
);
const token = required("BOAT_API_TOKEN");
const image = required("JETSKI_IMAGE");
const artifact = resolve(required("JETSKI_VOXL_ARTIFACT"));
const restoreConcurrency = memoryRestoreConcurrency(
  Number(process.env.JETSKI_DEMO_MEMORY_CONCURRENCY ?? "4"),
);
const memoryChunkBytes = Number(
  process.env.JETSKI_DEMO_MEMORY_CHUNK_BYTES ?? 4 * 1024 ** 2,
);
if (![1048576, 4194304].includes(memoryChunkBytes))
  throw Error("Demo memory chunks must be 1MiB or 4MiB");
// A new directory is required. Reconnection observes recorded operation IDs;
// rerunning a half-finished choreography must never replay uncertain commands.
await mkdir(directory, { mode: 0o700 });
const plan = {
  owner: "demo-" + randomUUID(),
  pool: randomUUID(),
  source: randomUUID(),
  create: randomUUID(),
  preparation: randomUUID(),
  memoryChunkBytes,
  restoreConcurrency,
  binaryReads: process.env.JETSKI_DEMO_BINARY_READS !== "0",
  suspend: randomUUID(),
  resume: randomUUID(),
  sourceExposure: randomUUID(),
  finalExposure: randomUUID(),
  branches: (["a", "b"] as const).map((panel) => ({
    panel,
    id: randomUUID(),
    copy: randomUUID(),
    resume: randomUUID(),
    exposure: randomUUID(),
  })),
};
await writeFile(
  resolve(directory, "plan.json"),
  JSON.stringify(plan, null, 2),
  { mode: 0o600, flag: "wx" },
);
const log = (name: string, value: unknown) =>
  appendFile(resolve(directory, name), JSON.stringify(value) + "\n", {
    mode: 0o600,
    flush: true,
  });
const timeline = await openTimeline(
  resolve(directory, "timeline-private.jsonl"),
);
// Connection URLs contain short-lived viewer credentials; keep logs private.
await writeFile(
  resolve(directory, "connection-private.json"),
  JSON.stringify({ url: timeline.url }),
  { mode: 0o600 },
);
console.log(
  "Dashboard connection saved in",
  resolve(directory, "connection-private.json"),
);
const jetski = await openJetski({
  owner: plan.owner,
  poolId: plan.pool,
  dataDirectory: resolve(directory, "controller"),
  image,
  waitTimeoutMs: 900000,
  hostsPerOwner: 3,
  hostStartupConcurrency: 3,
  // This dedicated controller has only two copies. Stream bounded objects in one
  // turn instead of waiting a scheduler second between each small batch.
  checkpointCopyBatchObjects: 256,
  memoryRestoreConcurrency: restoreConcurrency,
  timings: (timing) => {
    void log("stage-timings.jsonl", timing);
  },
  provider: {
    kind: "boat",
    token,
    machine: "default",
    ...(process.env.JETSKI_DEMO_BINARY_READS !== "0"
      ? { archiveReads: true }
      : {}),
    runtime: GVISOR_RUNTIME,
    networkMode: "public-egress",
    workloadInit: [
      "/bin/sh",
      "-ec",
      "while [ ! -x /workspace/launch-desktop ]; do sleep 0.2; done; exec /workspace/launch-desktop",
    ],
  },
  workloadResources: { cpus: 2, memoryMb: 2048 },
  hostLifecycle: {
    lifetimeMs: 3600000,
    drainMs: 300000,
    idle: { mode: "fixed", timeoutMs: 600000 },
  },
  onOperation: (operation) =>
    log("operations.jsonl", { at: new Date().toISOString(), ...operation }),
  onError: (error) => {
    void log("controller-errors.jsonl", {
      at: new Date().toISOString(),
      message:
        error instanceof Error ? error.message : "Unknown controller failure",
    });
  },
});
const gateway = await openDesktopGateway(
  jetski,
  plan.owner,
  resolve(directory, "streams.jsonl"),
);
let recording: Awaited<ReturnType<typeof recordDashboard>> | undefined;
const accesses: Array<{ close(): Promise<void> }> = [];
const failures: unknown[] = [];
async function collect(
  action: () => unknown | Promise<unknown>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    failures.push(error);
  }
}
const deadline = setTimeout(() => {
  void (async () => {
    await collect(() => gateway.close());
    await collect(() => jetski.close());
  })();
}, 55 * 60000);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = async (
  panel: Panel,
  phase: Parameters<typeof timeline.publish>[0]["phase"],
  message: string,
  desktopUrl?: string,
) => {
  recording?.assertHealthy();
  await timeline.publish({
    panel,
    phase,
    message,
    ...(desktopUrl ? { desktopUrl } : {}),
  });
};
let succeeded = false;
try {
  if (process.env.JETSKI_RECORD_CHROMIUM)
    recording = await recordDashboard(
      resolve(process.env.JETSKI_RECORD_CHROMIUM),
      resolve(directory, "capture"),
      timeline.url,
    );
  await pause(1500);
  await emit(
    "source",
    "loading",
    "Requesting a Boat host and isolated Jetski sandbox",
  );
  if (recording)
    await writeFile(
      resolve(directory, "recording-clock.json"),
      JSON.stringify({
        videoStartMs: recording.startedAtMs,
        timelineStartMs: timeline.startedAtMs,
      }),
      { mode: 0o600 },
    );
  // Preparation is real paid work and is included in the recorded elapsed clock.
  // Zero is available for a cold control run; no hidden background warm pool.
  if (process.env.JETSKI_DEMO_PREPARE_HOSTS !== "0") {
    const started = performance.now();
    for (const panel of ["source", "a", "b"] as const)
      await emit(
        panel,
        "loading",
        "Preparing owner-scoped host and approved image",
      );
    const prepared = await jetski.prepareHosts({
      count: 3,
      operationId: plan.preparation,
    });
    await log("preparation.jsonl", {
      elapsedMs: performance.now() - started,
      ...prepared,
    });
    await emit(
      "source",
      "loading",
      "Prepared host and cached image ready; creating sandbox",
    );
    for (const panel of ["a", "b"] as const)
      await emit(
        panel,
        "waiting",
        "Prepared host ready; waiting for source checkpoint",
      );
  }
  const source = await jetski.create({
    id: plan.source,
    operationId: plan.create,
  });
  await emit(
    "source",
    "loading",
    "Sandbox ready; preparing Chromium, Xvfb and Voxl",
  );
  const password = randomBytes(24).toString("base64url");
  await installDesktop(source, artifact, password);
  await chromiumState(source);
  const sourceView = await gateway.attach(
    source,
    password,
    plan.sourceExposure,
  );
  accesses.push(sourceView);
  await emit(
    "source",
    "live",
    "Chromium is running · memory-only counter starts at zero",
    sourceView.url,
  );
  await pause(2000);
  for (let step = 1; step <= 4; step++) {
    const state = await chromiumState(
      source,
      "(()=>{document.querySelector('#add').click();return {...window.demoState,note:document.querySelector('textarea').value}})()",
    );
    if (state.count !== step) throw Error("Source counter choreography failed");
    await emit(
      "source",
      "live",
      `Counter = ${step} · JavaScript memory`,
      sourceView.url,
    );
    await pause(700);
  }
  const originalFile =
    "Created in original\nCounter at checkpoint: 4\nUTF-8: ✓ λ 🚤\n";
  await source.writeFile("/workspace/fork-marker.txt", originalFile);
  const expected = await chromiumState(
    source,
    "(async()=>{document.querySelector('textarea').value='Born on source · held in RAM';await window.refreshDisk();return {...window.demoState,note:document.querySelector('textarea').value}})()",
  );
  await emit(
    "source",
    "live",
    "File written and acknowledged · ready to capture RAM + disk",
    sourceView.url,
  );
  await pause(2500);
  const snapshotUrl = timeline.snapshot(
    "source",
    await sourceView.screenshot(),
  );
  await timeline.publish({
    panel: "source",
    phase: "frozen",
    message: "Disconnecting viewers before checkpoint",
    snapshotUrl,
  });
  await sourceView.close();
  await pause(1000);
  await timeline.publish({
    panel: "source",
    phase: "loading",
    message: "Saving and verifying RAM + disk",
    snapshotUrl,
  });
  const checkpoint = await source.suspend({
    operationId: plan.suspend,
    portable: { codec: "gzip", chunkBytes: memoryChunkBytes, reuse: true },
  });
  await timeline.publish({
    panel: "source",
    phase: "frozen",
    message: "RAM + disk durably published and verified",
    snapshotUrl,
  });
  await log("oracle.jsonl", {
    source: expected,
    originalFile,
    checkpointId: checkpoint.id,
  });
  // Finish both immutable copies before admitting either placement. This barrier
  // prevents a faster copy from starting its host while its sibling is still copying.
  const copies = await Promise.all(
    plan.branches.map(async (branch) => {
      await emit(
        branch.panel,
        "loading",
        "Copying the same immutable RAM + disk checkpoint",
      );
      const sandbox = await jetski.fromCheckpoint({
        id: branch.id,
        operationId: branch.copy,
        sourceSandboxId: source.id,
        checkpointId: checkpoint.id,
        content: "memory",
      });
      await emit(
        branch.panel,
        "loading",
        "Checkpoint verified; waiting at parallel-start barrier",
      );
      return { ...branch, sandbox };
    }),
  );
  // IDs were persisted in plan.json before effects. Direct embedded admission
  // commits both intents before the next scheduler turn; facade calls below
  // observe the same existing operations, never dispatch native restore twice.
  await Promise.all(
    copies.map((branch) =>
      jetski.api.resumeMemory(branch.sandbox.id, branch.resume),
    ),
  );
  const branches = await Promise.all(
    copies.map(async (branch) => {
      const { sandbox } = branch;
      await emit(
        branch.panel,
        "loading",
        "Acquiring host and restoring processes concurrently",
      );
      await sandbox.resumeMemory({ operationId: branch.resume });
      const restored = await chromiumState(sandbox);
      assertSameBrowserState(restored, expected);
      if (
        (await sandbox.readText("/workspace/fork-marker.txt")) !== originalFile
      )
        throw Error("Restored file bytes differ");
      const view = await gateway.attach(sandbox, password, branch.exposure);
      accesses.push(view);
      await emit(
        branch.panel,
        "live",
        "Restored · same JS nonce, counter = 4, exact file bytes",
        view.url,
      );
      return { ...branch, view };
    }),
  );
  await pause(3500);
  await Promise.all(
    branches.map(async (branch) => {
      const label = branch.panel.toUpperCase();
      const steps = branch.panel === "a" ? 5 : 2;
      await chromiumState(
        branch.sandbox,
        `(()=>{document.body.dataset.branch='${label}';document.querySelector('#branch').textContent='Branch ${label}';document.querySelector('textarea').value='Branch ${label} · independent RAM';return {...window.demoState,note:document.querySelector('textarea').value}})()`,
      );
      for (let step = 0; step < steps; step++) {
        const state = await chromiumState(
          branch.sandbox,
          "(()=>{document.querySelector('#add').click();return {...window.demoState,note:document.querySelector('textarea').value}})()",
        );
        await emit(
          branch.panel,
          "live",
          `Independent action · counter = ${state.count}`,
          branch.view.url,
        );
        await pause(branch.panel === "a" ? 600 : 1400);
      }
      await branch.sandbox.writeFile(
        "/workspace/fork-marker.txt",
        `Branch ${label} changed this file\nIts sibling and original stay unchanged.\nUTF-8: ✓ λ 🚤\n`,
      );
      await chromiumState(
        branch.sandbox,
        "(async()=>{await window.refreshDisk();return {...window.demoState,note:document.querySelector('textarea').value}})()",
      );
      await emit(
        branch.panel,
        "live",
        "Different RAM + different file · isolated writable state",
        branch.view.url,
      );
    }),
  );
  await emit(
    "source",
    "loading",
    "Resuming original to verify it stayed unchanged",
  );
  await source.resumeMemory({ operationId: plan.resume });
  assertSameBrowserState(await chromiumState(source), expected);
  if ((await source.readText("/workspace/fork-marker.txt")) !== originalFile)
    throw Error("Original file changed");
  const originalView = await gateway.attach(
    source,
    password,
    plan.finalExposure,
  );
  accesses.push(originalView);
  await emit(
    "source",
    "live",
    "Original unchanged · counter = 4 and original file",
    originalView.url,
  );
  const proof = [];
  for (const branch of branches) {
    const state = await chromiumState(branch.sandbox);
    const label = branch.panel.toUpperCase();
    const expectedCount = branch.panel === "a" ? 9 : 6;
    if (
      state.nonce !== expected.nonce ||
      state.started !== expected.started ||
      state.count !== expectedCount ||
      state.note !== `Branch ${label} · independent RAM`
    )
      throw Error("Independent RAM comparison failed");
    const file = await branch.sandbox.readText("/workspace/fork-marker.txt");
    if (
      file !==
      `Branch ${label} changed this file\nIts sibling and original stay unchanged.\nUTF-8: ✓ λ 🚤\n`
    )
      throw Error("Independent file comparison failed");
    proof.push({
      panel: branch.panel,
      sandbox: await branch.sandbox.inspect(),
      state,
      file,
    });
    await emit(
      branch.panel,
      "complete",
      "Verified · independent RAM and exact disk bytes",
      branch.view.url,
    );
  }
  await emit(
    "source",
    "complete",
    "Verified · one checkpoint, three independent futures",
    originalView.url,
  );
  await writeFile(
    resolve(directory, "proof.json"),
    JSON.stringify({ expected, originalFile, branches: proof }, null, 2),
    { mode: 0o600 },
  );
  await pause(5000);
  if (recording) {
    await recording.stop(resolve(directory, "memory-fork.mp4"));
    recording = undefined;
  }
  succeeded = true;
} catch (error) {
  failures.push(error);
  await collect(() =>
    log("failure.jsonl", {
      at: new Date().toISOString(),
      message: error instanceof Error ? error.message : "Unknown demo failure",
    }),
  );
  await collect(() =>
    timeline.publish({
      panel: "source",
      phase: "failed",
      message: "Run stopped; failure and operation IDs preserved",
    }),
  );
  if (recording) {
    const activeRecording = recording;
    try {
      await activeRecording.stop(resolve(directory, "failed-run.mp4"));
    } catch (error) {
      failures.push(error);
      await collect(() => activeRecording.abort());
    }
    recording = undefined;
  }
} finally {
  clearTimeout(deadline);
  for (const access of accesses) await collect(() => access.close());
  await collect(() => gateway.close());
  // Core shutdown publishes acknowledged data first; uncertainty retains its source.
  await collect(() => jetski.close());
  await collect(() => timeline.close());
  await collect(() =>
    log("closed.jsonl", {
      at: new Date().toISOString(),
      succeeded: succeeded && failures.length === 0,
    }),
  );
}
if (failures.length)
  throw new AggregateError(failures, "Demo work or verified cleanup failed");

function required(name: string) {
  const value = process.env[name];
  if (!value) throw Error("Set " + name);
  return value;
}
