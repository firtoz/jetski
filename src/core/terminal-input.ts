import {
  canonical,
  identifier,
  type Json,
  type Scope,
  type StateStore,
  scopeKey,
  type Transaction,
} from "./contracts.js";
import type { HostLease } from "./pool.js";

export type TerminalGeometry = { rows: number; columns: number };
export const DEFAULT_TERMINAL_GEOMETRY: Readonly<TerminalGeometry> =
  Object.freeze({ rows: 24, columns: 80 });
export function terminalGeometry(
  value: unknown = DEFAULT_TERMINAL_GEOMETRY,
): TerminalGeometry {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "columns,rows"
  )
    throw Error("Invalid terminal geometry");
  const geometry = value as TerminalGeometry;
  if (
    ![geometry.rows, geometry.columns].every(
      (size) => Number.isInteger(size) && size >= 1 && size <= 4096,
    )
  )
    throw Error("Invalid terminal geometry");
  return { rows: geometry.rows, columns: geometry.columns };
}
export type TerminalInput =
  | { kind: "stdin"; base64: string }
  | { kind: "resize"; rows: number; columns: number }
  | { kind: "signal"; signal: "INT" | "QUIT" | "TSTP" }
  | { kind: "close" };
export const TERMINAL_INPUT_BYTES = 16384;
export function terminalFrame(input: TerminalInput): Uint8Array {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("Invalid terminal input");
  let tag: string, data: Uint8Array;
  const keys = Object.keys(input).sort().join(",");
  switch (input.kind) {
    case "stdin": {
      if (
        keys !== "base64,kind" ||
        typeof input.base64 !== "string" ||
        input.base64.length > 21848
      )
        throw Error("Invalid terminal bytes");
      const raw = atob(input.base64);
      if (
        !raw.length ||
        raw.length > TERMINAL_INPUT_BYTES ||
        btoa(raw) !== input.base64
      )
        throw Error("Invalid terminal bytes");
      tag = "I";
      data = Uint8Array.from(raw, (char) => char.charCodeAt(0));
      break;
    }
    case "resize":
      if (
        keys !== "columns,kind,rows" ||
        ![input.rows, input.columns].every(
          (value) => Number.isInteger(value) && value >= 1 && value <= 4096,
        )
      )
        throw Error("Invalid terminal dimensions");
      tag = "R";
      data = new Uint8Array([
        input.rows >> 8,
        input.rows & 255,
        input.columns >> 8,
        input.columns & 255,
      ]);
      break;
    case "signal": {
      const signals = { INT: 2, QUIT: 3, TSTP: 20 };
      if (keys !== "kind,signal" || !Object.hasOwn(signals, input.signal))
        throw Error("Unsupported terminal signal");
      tag = "S";
      data = new Uint8Array([signals[input.signal]]);
      break;
    }
    case "close":
      if (keys !== "kind") throw Error("Invalid terminal close");
      tag = "C";
      data = new Uint8Array();
      break;
    default:
      throw Error("Invalid terminal input kind");
  }
  const bytes = new Uint8Array(5 + data.length);
  bytes[0] = tag.charCodeAt(0);
  new DataView(bytes.buffer).setUint32(1, data.length);
  bytes.set(data, 5);
  return bytes;
}
type InputRecord = Scope & {
  command: string;
  sequence: number;
  id: string;
  lease: HostLease;
  image: string;
  input: TerminalInput;
  sha256: string;
  bytes: number;
  outcome: Json;
};
type Request = (
  lease: HostLease,
  action: string,
  payload: Json,
) => Promise<Json>;
/** Durable terminal delivery outcomes survive executor release. A transport ACK
 * proves socket acceptance only; uncertainty is retained, never retransmitted. */
export class TerminalInputJournal {
  constructor(
    private state: StateStore,
    private request: Request,
  ) {}
  private key(scope: Scope, command: string, id: string) {
    return `terminal-input/${scopeKey(scope)}/${identifier(command)}/${identifier(id)}`;
  }
  async admit(
    context: Scope & {
      command: string;
      id: string;
      lease: HostLease;
      image: string;
    },
    input: TerminalInput,
    guard: (tx: Transaction) => void,
  ): Promise<Json> {
    const frozen = structuredClone(input),
      bytes = terminalFrame(frozen);
    const sha256 = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const key = this.key(context, context.command, context.id);
    const record = await this.state.transaction((tx) => {
      const prior = tx.get<InputRecord>(key);
      if (prior) {
        if (canonical(prior.input) !== canonical(frozen))
          throw Error("Terminal input identity conflict");
        return prior;
      }
      guard(tx);
      const count = tx.scan(
        `terminal-input/${scopeKey(context)}/${identifier(context.command)}/`,
      ).length;
      if (count >= 4096) throw Error("Terminal input history bound");
      const value: InputRecord = {
        ...context,
        sequence: count,
        input: frozen,
        sha256,
        bytes: bytes.length,
        outcome: null,
      };
      tx.put(key, value);
      return value;
    });
    if (record.outcome !== null) return record.outcome;
    // Stable core admission order survives a controller crash before host admission.
    // Concurrent callers may observe/re-admit the same IDs, but never skip an
    // earlier input that has not yet been acknowledged by the host journal.
    const preceding = await this.state.transaction((tx) =>
      tx
        .scan<InputRecord>(
          `terminal-input/${scopeKey(context)}/${identifier(context.command)}/`,
        )
        .map((row) => row.value)
        .filter((item) => item.sequence <= record.sequence)
        .sort((a, b) => a.sequence - b.sequence),
    );
    let result: Json = null;
    for (const item of preceding) result = await this.drive(item);
    return result;
  }
  async status(scope: Scope, command: string, id: string): Promise<Json> {
    const record = await this.state.transaction((tx) =>
      tx.get<InputRecord>(this.key(scope, command, id)),
    );
    if (!record) throw Error("Terminal input unavailable");
    return record.outcome ?? { id, phase: "queued" };
  }
  private async drive(record: InputRecord, closing = false): Promise<Json> {
    if (record.outcome !== null) return record.outcome;
    const payload = {
      lease: record.lease,
      image: record.image,
      commandId: record.command,
      inputId: record.id,
    };
    let observed = await this.request(
      record.lease,
      "terminal-input-status",
      payload,
    );
    if (
      !observed ||
      typeof observed !== "object" ||
      Array.isArray(observed) ||
      observed.id !== record.id
    )
      throw Error("Invalid terminal input receipt");
    if (observed.phase === "absent") {
      if (
        typeof observed.closed !== "boolean" ||
        Object.keys(observed).sort().join(",") !== "closed,id,phase"
      )
        throw Error("Invalid input absence proof");
      if (observed.closed)
        observed = {
          id: record.id,
          phase: "cancelled",
          sequence: null,
          kind: record.input.kind,
          bytes: record.bytes,
          sha256: record.sha256,
        };
      else {
        if (closing) throw Error("Terminal source not closed");
        observed = await this.request(record.lease, "terminal-input", {
          ...payload,
          input: record.input,
        });
      }
    }
    if (
      !observed ||
      typeof observed !== "object" ||
      Array.isArray(observed) ||
      observed.id !== record.id ||
      observed.kind !== record.input.kind ||
      observed.bytes !== record.bytes ||
      observed.sha256 !== record.sha256 ||
      !["queued", "sent", "uncertain", "cancelled"].includes(
        String(observed.phase),
      ) ||
      Object.keys(observed).sort().join(",") !==
        "bytes,id,kind,phase,sequence,sha256"
    )
      throw Error("Invalid terminal delivery receipt");
    if (
      observed.sequence !== null &&
      (!Number.isSafeInteger(observed.sequence) ||
        Number(observed.sequence) < 0)
    )
      throw Error("Invalid terminal input sequence");
    if (observed.sequence === null && observed.phase !== "cancelled")
      throw Error("Missing terminal input sequence");
    if (observed.phase === "queued") {
      if (closing) throw Error("Terminal input remains pending");
      return observed;
    }
    const outcome = observed;
    await this.state.transaction((tx) => {
      const key = this.key(record, record.command, record.id),
        current = tx.get<InputRecord>(key);
      if (!current || current.sha256 !== record.sha256)
        throw Error("Terminal input record changed");
      if (
        current.outcome !== null &&
        canonical(current.outcome) !== canonical(outcome)
      )
        throw Error("Terminal input outcome conflict");
      tx.put(key, { ...current, outcome });
    });
    return outcome;
  }
  async reconcile(owner: string): Promise<void> {
    const records = await this.state.transaction((tx) =>
      tx
        .scan<InputRecord>(`terminal-input/${identifier(owner)}/`)
        .map((row) => row.value),
    );
    records.sort((a, b) => a.sequence - b.sequence);
    for (const record of records)
      if (record.outcome === null) await this.drive(record);
  }
  async settle(scope: Scope): Promise<void> {
    const records = await this.state.transaction((tx) =>
      tx
        .scan<InputRecord>(`terminal-input/${scopeKey(scope)}/`)
        .map((row) => row.value),
    );
    records.sort((a, b) => a.sequence - b.sequence);
    for (const record of records)
      if (record.outcome === null) await this.drive(record, true);
  }
}
