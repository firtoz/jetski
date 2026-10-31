import { OUTPUT_LIMIT } from "../core/command-output.js";
import {
  canonical,
  identifier,
  type Json,
  type StateStore,
} from "../core/contracts.js";
import { type TerminalInput, terminalFrame } from "../core/terminal-input.js";
import { observationDelay } from "./wait.js";

export type TerminalPeer = {
  observe(id: string, signal?: AbortSignal): Promise<Json | undefined>;
  admit(id: string, input: TerminalInput, signal?: AbortSignal): Promise<Json>;
};
type Target = { binding: string; sandbox: string; terminal: string };
type Pending = {
  id: string;
  input: TerminalInput;
  sha256: string;
  bytes: number;
  outcome: Json;
};
type Journal = Target & { version: 1; cursor: number; pending: Pending | null };
function verifyOutcome(pending: Pending, outcome: Json): void {
  if (
    !outcome ||
    typeof outcome !== "object" ||
    Array.isArray(outcome) ||
    Object.keys(outcome).sort().join(",") !==
      "bytes,id,kind,phase,sequence,sha256" ||
    outcome.id !== pending.id ||
    outcome.kind !== pending.input.kind ||
    outcome.sha256 !== pending.sha256 ||
    outcome.bytes !== pending.bytes ||
    !["sent", "uncertain", "cancelled"].includes(String(outcome.phase)) ||
    (outcome.sequence === null
      ? outcome.phase !== "cancelled"
      : !Number.isSafeInteger(outcome.sequence) || Number(outcome.sequence) < 0)
  )
    throw Error("Attachment receipt identity mismatch");
}
export class TerminalDeliveryError extends Error {
  constructor(
    readonly inputId: string,
    readonly phase: "uncertain" | "cancelled",
  ) {
    super(`Terminal input ${inputId} is ${phase}; further input is blocked`);
  }
}
/** One pending input per durable client attachment. Server receipts remain the
 * history authority; this journal protects reconnect identity and output cursor. */
export class TerminalAttachment {
  private constructor(
    private readonly state: StateStore,
    private readonly key: string,
    private readonly target: Target,
    private readonly peer: TerminalPeer,
  ) {}
  static async open(
    state: StateStore,
    id: string,
    target: Target,
    peer: TerminalPeer,
  ) {
    identifier(target.sandbox);
    identifier(target.terminal);
    if (!/^[a-f0-9]{64}$/.test(target.binding))
      throw Error("Invalid attachment binding");
    const attachment = new TerminalAttachment(
      state,
      `client-terminal/${identifier(id)}`,
      structuredClone(target),
      peer,
    );
    await state.transaction((tx) => {
      const prior = tx.get<Journal>(attachment.key);
      if (prior) attachment.validate(prior);
      else
        tx.put(attachment.key, {
          ...target,
          version: 1,
          cursor: 0,
          pending: null,
        });
    });
    return attachment;
  }
  private validate(record: Journal | undefined): Journal {
    if (
      !record ||
      record.version !== 1 ||
      record.binding !== this.target.binding ||
      record.sandbox !== this.target.sandbox ||
      record.terminal !== this.target.terminal ||
      !Number.isSafeInteger(record.cursor) ||
      record.cursor < 0 ||
      record.cursor > OUTPUT_LIMIT
    )
      throw Error("Attachment journal identity or cursor mismatch");
    return record;
  }
  async cursor(): Promise<number> {
    return this.state.transaction(
      (tx) => this.validate(tx.get<Journal>(this.key)).cursor,
    );
  }
  async acknowledgeOutput(offset: number, nextOffset: number): Promise<void> {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(nextOffset) ||
      offset < 0 ||
      nextOffset < offset ||
      nextOffset > OUTPUT_LIMIT
    )
      throw Error("Invalid output acknowledgement");
    await this.state.transaction((tx) => {
      const record = this.validate(tx.get<Journal>(this.key));
      if (record.cursor !== offset)
        throw Error("Output acknowledgement conflict");
      tx.put(this.key, { ...record, cursor: nextOffset });
    });
  }
  async send(input: TerminalInput, signal?: AbortSignal): Promise<Json> {
    signal?.throwIfAborted();
    const frozen = structuredClone(input),
      bytes = terminalFrame(frozen);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new Uint8Array(bytes).buffer,
    );
    const sha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    await this.state.transaction((tx) => {
      const record = this.validate(tx.get<Journal>(this.key));
      if (
        record.pending &&
        (!record.pending.outcome ||
          (record.pending.outcome as { phase?: string }).phase !== "sent")
      )
        throw Error("Unresolved terminal input; resume attachment first");
      if (record.pending) verifyOutcome(record.pending, record.pending.outcome);
      const pending: Pending = {
        id: crypto.randomUUID(),
        input: frozen,
        sha256,
        bytes: bytes.length,
        outcome: null,
      };
      tx.put(this.key, { ...record, pending });
    });
    return this.resume(signal);
  }
  async resume(signal?: AbortSignal): Promise<Json> {
    const pending = await this.state.transaction(
      (tx) => this.validate(tx.get<Journal>(this.key)).pending,
    );
    if (!pending) return null;
    // Validate local immutable input before any remote contact.
    const frame = terminalFrame(pending.input);
    const digest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new Uint8Array(frame).buffer),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    if (pending.bytes !== frame.length || pending.sha256 !== digest)
      throw Error("Corrupt attachment input");
    let outcome = pending.outcome;
    while (!outcome) {
      signal?.throwIfAborted();
      let observed = await this.peer.observe(pending.id, signal);
      if (observed === undefined)
        observed = await this.peer.admit(pending.id, pending.input, signal);
      if (
        !observed ||
        typeof observed !== "object" ||
        Array.isArray(observed) ||
        observed.id !== pending.id
      )
        throw Error("Invalid attachment receipt");
      if (observed.phase === "queued") {
        await observationDelay(signal);
        continue;
      }
      verifyOutcome(pending, observed);
      outcome = observed;
      await this.state.transaction((tx) => {
        const record = this.validate(tx.get<Journal>(this.key));
        if (record.pending?.id !== pending.id)
          throw Error("Concurrent attachment input changed");
        if (
          record.pending.outcome &&
          canonical(record.pending.outcome) !== canonical(outcome)
        )
          throw Error("Attachment outcome conflict");
        tx.put(this.key, {
          ...record,
          pending: { ...record.pending, outcome },
        });
      });
    }
    verifyOutcome(pending, outcome);
    const phase = (outcome as { phase: string }).phase;
    if (phase === "uncertain" || phase === "cancelled")
      throw new TerminalDeliveryError(pending.id, phase);
    if (phase !== "sent") throw Error("Invalid persisted attachment outcome");
    return outcome;
  }
}
