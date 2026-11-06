import { decodeBase64 } from "./command-output.js";
import {
  canonical,
  type Json,
  type Scope,
  type StateStore,
  scopeKey,
} from "./contracts.js";
import { persistentPath } from "./files.js";
import type { Sandbox } from "./manager.js";
import type { OperationJournal } from "./operations.js";
import type { HostLease } from "./pool.js";

export const MAX_FILE_UPLOAD_BYTES = 64 * 1024 * 1024;
export type UploadSpec = {
  path: string;
  bytes: number;
  sha256: string;
  mode: number;
};
export type UploadStatus = UploadSpec & {
  id: string;
  offset: number;
  phase: "receiving" | "finishing" | "committed" | "aborted" | "uncertain";
};
type Record = UploadStatus & {
  initialized?: true;
  owner: string;
  sandbox: string;
  generation: number;
  lease: HostLease;
  image: string;
};
type Request = (
  lease: HostLease,
  action: string,
  payload: Json,
) => Promise<Json>;
const prefix = (scope: Scope) => `upload/${scopeKey(scope)}/`;
const key = (scope: Scope, id: string) => `${prefix(scope)}${id}`;
function publicStatus(record: Record): UploadStatus {
  const { id, path, bytes, sha256, mode, offset, phase } = record;
  return { id, path, bytes, sha256, mode, offset, phase };
}
function validate(id: string, spec: UploadSpec) {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
  )
    throw Error("UUID required");
  persistentPath(spec.path);
  if (
    ["/workspace", "/home/sandbox"].includes(spec.path) ||
    !Number.isSafeInteger(spec.bytes) ||
    spec.bytes < 0 ||
    spec.bytes > MAX_FILE_UPLOAD_BYTES ||
    !/^[a-f0-9]{64}$/.test(spec.sha256) ||
    !Number.isSafeInteger(spec.mode) ||
    spec.mode < 0 ||
    spec.mode > 0o777
  )
    throw Error("Invalid upload specification");
}
/** Immutable admission and finish intent precede host effects. Host replay is safe
 * only because its private publication journal consumes the staged inode once. */
export class UploadCoordinator {
  constructor(
    private state: StateStore,
    private operations: OperationJournal,
    private request: Request,
  ) {}
  private async record(scope: Scope, id: string) {
    const record = await this.state.transaction((tx) =>
      tx.get<Record>(key(scope, id)),
    );
    if (!record) throw Error("Upload unavailable");
    return record;
  }
  private async host(
    record: Record,
    action: string,
    extra: Json = {},
  ): Promise<UploadStatus> {
    const value = await this.request(record.lease, action, {
      lease: record.lease,
      image: record.image,
      uploadId: record.id,
      path: record.path,
      bytes: record.bytes,
      sha256: record.sha256,
      mode: record.mode,
      ...(extra as { [key: string]: Json }),
    });
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.id !== record.id ||
      value.path !== record.path ||
      value.bytes !== record.bytes ||
      value.sha256 !== record.sha256 ||
      value.mode !== record.mode ||
      typeof value.offset !== "number" ||
      !Number.isSafeInteger(value.offset) ||
      value.offset < 0 ||
      value.offset > record.bytes ||
      !["receiving", "publishing", "committed", "uncertain"].includes(
        String(value.phase),
      )
    )
      throw Error("Invalid upload receipt");
    if (
      (value.phase === "committed" || value.phase === "publishing") &&
      value.offset !== record.bytes
    )
      throw Error("Incomplete publication receipt");
    return {
      ...publicStatus(record),
      offset: value.offset,
      phase:
        value.phase === "publishing"
          ? "finishing"
          : (value.phase as UploadStatus["phase"]),
    };
  }
  private async initialize(record: Record): Promise<UploadStatus> {
    const result = await this.host(record, "file-write-begin");
    await this.state.transaction((tx) => {
      const current = tx.get<Record>(key(record, record.id));
      if (
        !current ||
        current.generation !== record.generation ||
        canonical(current.lease) !== canonical(record.lease)
      )
        throw Error("Upload initialization authority changed");
      if (current.phase === "receiving" && !current.initialized)
        tx.put(key(record, record.id), { ...current, initialized: true });
    });
    return result;
  }
  async begin(
    scope: Scope,
    id: string,
    spec: UploadSpec,
  ): Promise<UploadStatus> {
    validate(id, spec);
    const record = await this.state.transaction((tx) => {
      const prior = tx.get<Record>(key(scope, id));
      if (prior) {
        if (
          canonical({
            path: prior.path,
            bytes: prior.bytes,
            sha256: prior.sha256,
            mode: prior.mode,
          }) !== canonical(spec)
        )
          throw Error("Upload identity conflict");
        return prior;
      }
      const sandbox = tx.get<Sandbox>(`sandbox/${scopeKey(scope)}`);
      if (
        !sandbox?.lease ||
        sandbox.phase !== "running" ||
        sandbox.pendingResume
      )
        throw Error("Sandbox unavailable");
      const fence = { ...scope, generation: sandbox.generation };
      this.operations.admitIn(tx, fence, id, "file-write", spec);
      this.operations.claimIn(tx, fence, id);
      const next: Record = {
        ...scope,
        ...spec,
        id,
        generation: sandbox.generation,
        lease: sandbox.lease,
        image: sandbox.image,
        offset: 0,
        phase: "receiving",
      };
      tx.put(key(scope, id), next);
      return next;
    });
    if (record.phase !== "receiving") return publicStatus(record);
    return this.initialize(record);
  }
  async status(scope: Scope, id: string): Promise<UploadStatus> {
    const record = await this.record(scope, id);
    if (record.phase !== "receiving") return publicStatus(record);
    return this.host(record, "file-write-begin");
  }
  async chunk(
    scope: Scope,
    id: string,
    offset: number,
    base64: string,
    sha256: string,
  ): Promise<UploadStatus> {
    const data = decodeBase64(base64);
    if (
      !data.length ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !/^[a-f0-9]{64}$/.test(sha256)
    )
      throw Error("Invalid upload chunk");
    const record = await this.state.transaction((tx) => {
      const record = tx.get<Record>(key(scope, id)),
        sandbox = tx.get<Sandbox>(`sandbox/${scopeKey(scope)}`);
      if (
        !record ||
        record.phase !== "receiving" ||
        sandbox?.phase !== "running" ||
        sandbox.generation !== record.generation ||
        offset + data.length > record.bytes
      )
        throw Error("Upload cannot receive bytes");
      return record;
    });
    if (!record.initialized) await this.initialize(record);
    return this.host(record, "file-write-chunk", { offset, base64, sha256 });
  }
  async finish(scope: Scope, id: string): Promise<UploadStatus> {
    let record = await this.record(scope, id);
    if (record.phase === "receiving") {
      const observed = await this.host(record, "file-write-begin");
      if (observed.offset !== record.bytes) throw Error("Upload incomplete");
      record = await this.state.transaction((tx) => {
        const current = tx.get<Record>(key(scope, id)),
          sandbox = tx.get<Sandbox>(`sandbox/${scopeKey(scope)}`);
        if (!current) throw Error("Upload unavailable");
        if (current.phase !== "receiving") return current;
        if (
          sandbox?.phase !== "running" ||
          sandbox.generation !== current.generation
        )
          throw Error("Sandbox unavailable");
        const next: Record = {
          ...current,
          offset: current.bytes,
          phase: "finishing",
        };
        tx.put(key(scope, id), next);
        return next;
      });
    }
    return this.publish(record);
  }
  private async publish(record: Record): Promise<UploadStatus> {
    if (record.phase !== "finishing") return publicStatus(record);
    try {
      const result = await this.host(record, "file-write-finish");
      if (result.phase !== "committed")
        throw Error("Upload publication uncertain");
      return await this.state.transaction((tx) => {
        const current = tx.get<Record>(key(record, record.id));
        if (!current || current.generation !== record.generation)
          throw Error("Upload changed");
        if (current.phase === "committed") return publicStatus(current);
        if (current.phase !== "finishing") throw Error("Upload changed");
        const next: Record = {
          ...current,
          offset: current.bytes,
          phase: "committed",
        };
        this.operations.finishIn(tx, record, record.id, {
          phase: "succeeded",
          result: publicStatus(next),
          error: null,
        });
        tx.put(key(record, record.id), next);
        return publicStatus(next);
      });
    } catch (error) {
      await this.state.transaction((tx) => {
        const current = tx.get<Record>(key(record, record.id));
        if (current?.phase === "finishing")
          this.operations.finishIn(tx, record, record.id, {
            phase: "uncertain",
            result: null,
            error: "Upload publication requires reconciliation",
          });
      });
      throw error;
    }
  }
  async reconcile(owner: string): Promise<void> {
    const records = await this.state.transaction((tx) =>
      tx.scan<Record>(`upload/${owner}/`).map((row) => row.value),
    );
    for (const record of records)
      if (record.phase === "finishing") await this.publish(record);
  }
  /** Shutdown already closed controller admission, but the host stays open until
   * all durable finish intents are settled. Incomplete staging is not a file write. */
  async settle(scope: Scope): Promise<void> {
    const records = await this.state.transaction((tx) => {
      const records = tx.scan<Record>(prefix(scope)).map((row) => row.value);
      for (const record of records)
        if (record.phase === "receiving") {
          const next: Record = { ...record, phase: "aborted" };
          this.operations.finishIn(tx, record, record.id, {
            phase: "failed",
            result: publicStatus(next),
            error: "Incomplete upload aborted by shutdown",
          });
          tx.put(key(scope, record.id), next);
        }
      return records;
    });
    for (const record of records)
      if (record.phase === "finishing") await this.publish(record);
  }
}
