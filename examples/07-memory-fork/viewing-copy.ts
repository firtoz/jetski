import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TimelineEvent } from "./timeline.js";

type Segment = { start: number; end: number; speed: 1 | 16 };

/** An explicitly labelled viewing edit. The original MP4 and real timeline stay
 * intact; only long waits accelerate, with three seconds at each end preserved. */
export async function makeViewingCopy(directory: string, output: string) {
  const proof = JSON.parse(
    await readFile(join(directory, "proof.json"), "utf8"),
  ) as { branches?: unknown[] };
  if (proof.branches?.length !== 2)
    throw Error(
      "A successful two-branch proof is required before making the showcase",
    );
  const raw = join(directory, "memory-fork.mp4");
  const probe = await command("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    raw,
  ]);
  const duration = Number(
    (JSON.parse(probe) as { format: { duration: string } }).format.duration,
  );
  if (!Number.isFinite(duration) || duration <= 0)
    throw Error("Invalid original recording duration");
  const clock = JSON.parse(
    await readFile(join(directory, "recording-clock.json"), "utf8"),
  ) as { videoStartMs: number; timelineStartMs: number };
  const offset = (clock.timelineStartMs - clock.videoStartMs) / 1000;
  if (!Number.isFinite(offset) || offset < 0 || offset > 60)
    throw Error("Invalid recording-clock correspondence");
  const events = (
    await readFile(join(directory, "timeline-private.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as TimelineEvent);
  const boundaries = [
    0,
    ...events
      .map((event) => event.elapsedMs / 1000 + offset)
      .filter((time) => time > 0 && time < duration),
    duration,
  ].sort((a, b) => a - b);
  const segments: Segment[] = [];
  for (let index = 0; index < boundaries.length - 1; index++) {
    const start = boundaries[index]!,
      end = boundaries[index + 1]!;
    if (end - start < 0.01) continue;
    if (end - start > 12)
      segments.push(
        { start, end: start + 3, speed: 1 },
        { start: start + 3, end: end - 3, speed: 16 },
        { start: end - 3, end, speed: 1 },
      );
    else segments.push({ start, end, speed: 1 });
  }
  const parts = join(directory, "viewing-copy-parts");
  await mkdir(parts, { mode: 0o700 });
  await writeFile(
    join(parts, "edit.json"),
    JSON.stringify({ raw, duration, clock, segments }, null, 2),
    { mode: 0o600 },
  );
  for (const [index, segment] of segments.entries()) {
    const label =
      segment.speed === 16
        ? ",drawtext=text='16x REAL WAIT - clock shows actual elapsed time':fontsize=20:fontcolor=0x6fe8c5:x=(w-tw)/2:y=h-70:box=1:boxcolor=0x071116:boxborderw=10"
        : "";
    await command("ffmpeg", [
      "-v",
      "error",
      "-nostdin",
      "-n",
      "-ss",
      segment.start.toFixed(6),
      "-t",
      (segment.end - segment.start).toFixed(6),
      "-i",
      raw,
      "-an",
      "-vf",
      `setpts=(PTS-STARTPTS)/${segment.speed},fps=30${label}`,
      "-c:v",
      "libx264",
      "-threads",
      "4",
      "-preset",
      "fast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      join(parts, `part-${String(index).padStart(3, "0")}.mp4`),
    ]);
  }
  await writeFile(
    join(parts, "parts.txt"),
    segments
      .map((_, index) => `file 'part-${String(index).padStart(3, "0")}.mp4'\n`)
      .join(""),
    { mode: 0o600 },
  );
  await command("ffmpeg", [
    "-v",
    "error",
    "-nostdin",
    "-n",
    "-f",
    "concat",
    "-safe",
    "1",
    "-i",
    join(parts, "parts.txt"),
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    resolve(output),
  ]);
  return {
    originalSeconds: duration,
    viewingSeconds: segments.reduce(
      (sum, segment) => sum + (segment.end - segment.start) / segment.speed,
      0,
    ),
  };
}

async function command(executable: string, args: string[]) {
  const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  let bytes = 0;
  const capture = (target: Buffer[]) => (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) child.kill();
    else target.push(chunk);
  };
  child.stdout.on("data", capture(stdout));
  child.stderr.on("data", capture(stderr));
  const timer = setTimeout(() => child.kill(), 10 * 60000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(
              Error(
                executable + " failed: " + Buffer.concat(stderr).toString(),
              ),
            ),
      );
    });
    return Buffer.concat(stdout).toString();
  } finally {
    clearTimeout(timer);
  }
}
