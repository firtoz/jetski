/** Uses only fresh random fixture scopes. Never provisions buckets or machines. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type StorageConfig,
  standaloneStorage,
} from "../src/server/storage.js";
import {
  qualifyStorage,
  StorageConformanceError,
} from "../src/testing/storage.js";

const temporary = await mkdtemp(
  join(tmpdir(), "jetski-storage-qualification-"),
);
try {
  let config: StorageConfig = { kind: "local" };
  if (process.argv[2])
    config = JSON.parse(
      await readFile(process.argv[2], "utf8"),
    ) as StorageConfig;
  if (config.kind === "s3") config = { ...config, listPageSize: 1 };
  const report = await qualifyStorage(() =>
    standaloneStorage(temporary, config),
  );
  console.log(JSON.stringify({ backend: config.kind, ...report }));
} catch (error) {
  if (error instanceof StorageConformanceError)
    console.log(JSON.stringify(error.report));
  else
    console.log(
      JSON.stringify({
        passed: false,
        phase: "configuration",
        cleanup: "no remote objects admitted",
      }),
    );
  process.exitCode = 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
