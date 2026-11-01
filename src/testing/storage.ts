import { createHash, randomUUID } from "node:crypto";
import type {
  ByteStream,
  CheckpointStore,
  ObjectAddress,
  ObjectInfo,
  Scope,
} from "../core/contracts.js";
import { verifyObjectRanges } from "../core/object-ranges.js";

export type StoreSession = {
  store: CheckpointStore;
  close: () => void | Promise<void>;
};
export type StorageConformanceReport = {
  version: 1;
  passed: boolean;
  phase: string;
  owner: string;
  sandbox: string;
  foreignOwner: string;
  checks: string[];
  adapterCalls: Record<string, number>;
  elapsedMs: number;
  cleanup: {
    complete: boolean;
    objectsAttempted: number;
    failedObjects: ObjectAddress[];
    reservationMarkersRetained: true;
  };
  limits: { objectBytes: number; objectIdentities: number };
};
export class StorageConformanceError extends Error {
  constructor(readonly report: StorageConformanceReport) {
    super(`Storage conformance failed during ${report.phase}`);
  }
}
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const source = (bytes: Uint8Array): ByteStream =>
  (async function* () {
    for (let at = 0; at < bytes.length; at += 4093)
      yield bytes.subarray(at, at + 4093);
  })();
function require(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
async function rejects(action: () => Promise<unknown>) {
  let rejected = false;
  try {
    await action();
  } catch {
    rejected = true;
  }
  require(rejected, "Expected rejection");
}
async function collect(stream: ByteStream, limit: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    require(bytes <= limit, "Read exceeds fixture bound");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
/** Writes only fresh random owner scopes. This is a bounded functional contract,
 * not a provider durability, real-grace GC or host-replacement qualification. */
export async function qualifyStorage(
  open: () => Promise<StoreSession>,
): Promise<StorageConformanceReport> {
  const started = Date.now(),
    run = randomUUID();
  const scope: Scope = { owner: `qualification-${run}`, sandbox: "fixture" },
    foreign = { ...scope, owner: `foreign-${run}` };
  const report: StorageConformanceReport = {
    version: 1,
    passed: false,
    phase: "open",
    ...scope,
    foreignOwner: foreign.owner,
    checks: [],
    adapterCalls: {},
    elapsedMs: 0,
    cleanup: {
      complete: false,
      objectsAttempted: 0,
      failedObjects: [],
      reservationMarkersRetained: true,
    },
    limits: { objectBytes: 65539, objectIdentities: 7 },
  };
  let session: StoreSession | undefined;
  const addresses: ObjectAddress[] = [];
  const count = (kind: string) => {
    report.adapterCalls[kind] = (report.adapterCalls[kind] ?? 0) + 1;
  };
  const put = async (
    address: ObjectAddress,
    bytes: Uint8Array,
    stream = source(bytes),
    digest = sha(bytes),
  ) => {
    count("put");
    return session!.store.put(address, stream, {
      bytes: bytes.length,
      sha256: digest,
    });
  };
  const head = async (address: ObjectAddress) => {
    count("head");
    return session!.store.head(address);
  };
  const read = async (
    address: ObjectAddress,
    range?: { start: number; endExclusive: number },
  ) => {
    count("read");
    return collect(
      session!.store.read(address, range),
      report.limits.objectBytes,
    );
  };
  const list = async (scope: Scope) => {
    count("list");
    const entries: ObjectInfo[] = [];
    for await (const entry of session!.store.list(scope)) {
      require(entries.length < 7, "Unexpected inventory growth");
      require(entry.owner === scope.owner &&
        entry.sandbox === scope.sandbox, "Foreign inventory entry");
      entries.push(entry);
    }
    return entries;
  };
  const remove = async (address: ObjectAddress) => {
    count("delete");
    await session!.store.delete(address);
  };
  const address = (id: string, ownerScope = scope) => {
    const value = { ...ownerScope, id };
    addresses.push(value);
    return value;
  };
  try {
    session = await open();
    require(!(await list(scope)).length &&
      !(await list(foreign)).length, "Fresh scope must be empty");
    const bytes = Buffer.alloc(report.limits.objectBytes);
    for (let index = 0; index < bytes.length; index++)
      bytes[index] = index % 256;
    const primary = address("primary"),
      other = address("primary", foreign),
      empty = address("empty");
    report.phase = "bytes-and-isolation";
    require((await put(primary, bytes)).sha256 ===
      sha(bytes), "Publication mismatch");
    const expectedPrimary = {
      ...primary,
      bytes: bytes.length,
      sha256: sha(bytes),
    };
    const slices = [
      {
        start: 3,
        endExclusive: bytes.length - 3,
        sha256: sha(bytes.subarray(3, -3)),
      },
    ];
    const verifySlices = async () => {
      count(session!.store.verifyRanges ? "verifyRanges" : "read");
      await verifyObjectRanges(session!.store, expectedPrimary, slices);
      count(session!.store.verifyRanges ? "verifyRanges" : "read");
      await rejects(() =>
        verifyObjectRanges(session!.store, expectedPrimary, [
          { ...slices[0]!, sha256: "0".repeat(64) },
        ]),
      );
    };
    await verifySlices();
    await put(other, Buffer.from("foreign bytes"));
    await put(empty, Buffer.alloc(0));
    require((await read(primary)).equals(bytes), "Full read mismatch");
    require((
      await read(primary, { start: 65530, endExclusive: bytes.length })
    ).equals(bytes.subarray(65530)), "Range mismatch");
    require((await read(primary, { start: 2, endExclusive: 2 })).length ===
      0, "Empty range mismatch");
    require((await read(empty)).length === 0, "Empty object mismatch");
    await rejects(() => read(primary, { start: -1, endExclusive: 1 }));
    await rejects(() => put(primary, Buffer.from("replacement")));
    require((await read(primary)).equals(bytes), "Duplicate put changed data");
    report.checks.push(
      "binary-range-empty",
      "owner-isolation",
      "immutable-put",
    );
    report.phase = "interrupted-writes";
    const interrupted = address("interrupted"),
      corrupt = address("corrupt");
    await rejects(() =>
      put(
        interrupted,
        bytes,
        (async function* () {
          yield bytes.subarray(0, 10);
          throw Error("Injected source interruption");
        })(),
      ),
    );
    require((await head(interrupted)) === undefined, "Partial data published");
    await rejects(() => put(interrupted, bytes));
    await rejects(() => put(corrupt, bytes, source(bytes), "0".repeat(64)));
    require((await head(corrupt)) === undefined, "Corrupt data published");
    await rejects(() => put(corrupt, bytes));
    report.checks.push(
      "interrupted-write",
      "integrity-rejection",
      "failed-identity-reservation",
    );
    report.phase = "concurrent-create";
    const race = address("race");
    const races = await Promise.allSettled([
      put(race, bytes),
      put(race, bytes),
    ]);
    require(races.filter((result) => result.status === "fulfilled").length ===
      1, "Conditional create is not exclusive");
    report.checks.push("exclusive-create");
    report.phase = "reopen";
    await session.close();
    session = undefined;
    session = await open();
    require((await read(primary)).equals(bytes), "Reopen lost bytes");
    const info = await head(primary);
    require(info?.sha256 === sha(bytes) &&
      info.bytes === bytes.length, "Reopen metadata mismatch");
    require((await read(other)).equals(
      Buffer.from("foreign bytes"),
    ), "Foreign owner bytes changed");
    const inventory = (await list(scope)).map((entry) => entry.id).sort();
    require(JSON.stringify(inventory) ===
      JSON.stringify(["empty", "primary", "race"]), "Incomplete inventory");
    await verifySlices();
    report.checks.push(
      "fresh-client-recovery",
      "complete-inventory",
      "verified-slices-and-reopen",
    );
    report.phase = "delete-and-tombstone";
    await remove(primary);
    await remove(primary);
    require((await head(primary)) === undefined, "Delete not observed");
    await rejects(() => put(primary, bytes));
    require((await read(other)).equals(
      Buffer.from("foreign bytes"),
    ), "Cross-owner delete");
    report.checks.push(
      "idempotent-delete",
      "permanent-identity",
      "scoped-delete",
    );
    report.passed = true;
    report.phase = "complete";
  } catch {
    report.passed = false;
  } finally {
    const failedPhase = report.phase;
    try {
      session ??= await open();
      let cleanupFailed = false;
      for (const entry of addresses) {
        report.cleanup.objectsAttempted++;
        try {
          await remove(entry);
        } catch {
          cleanupFailed = true;
          report.cleanup.failedObjects.push(entry);
        }
      }
      require(!cleanupFailed, "Fixture deletion failed");
      require(!(await list(scope)).length &&
        !(await list(foreign)).length, "Cleanup inventory not empty");
      report.cleanup.complete = true;
    } catch {
      report.passed = false;
      if (failedPhase === "complete") report.phase = "cleanup";
    }
    try {
      await session?.close();
    } catch {
      report.passed = false;
      if (report.phase === "complete") report.phase = "close";
    }
    report.elapsedMs = Date.now() - started;
  }
  if (!report.passed) throw new StorageConformanceError(report);
  return report;
}
