import {
  canonical,
  identifier,
  type Scope,
  type StateStore,
  scopeKey,
  type Transaction,
} from "./contracts.js";
import type { OperationJournal } from "./operations.js";
import type { PortRegistry } from "./ports.js";

export const PREVIEW_GRANT_MS = 60_000;
export const PREVIEW_SESSION_MS = 15 * 60_000;
const MAX_PREVIEW_GRANTS = 4096;
export type PreviewBinding = { exposureId: string; origin: string };
type Grant = PreviewBinding & {
  id: string;
  generation: number;
  createdAt: number;
  grantExpiresAt: number;
  sessionExpiresAt: number;
  bootstrap: string;
  bootstrapHash: string;
  session: string;
  sessionHash: string;
  redemption: string | null;
  revoked: boolean;
};
export type PreviewGrant = {
  id: string;
  token: string;
  expiresAt: number;
  origin: string;
};
export type PreviewSession = { id: string; cookie: string; expiresAt: number };
export type PreviewSessionStatus = PreviewBinding & {
  id: string;
  generation: number;
  grantExpiresAt: number;
  sessionExpiresAt: number;
  redeemed: boolean;
  revoked: boolean;
};
function normalize(binding: PreviewBinding): PreviewBinding {
  if (
    typeof binding.origin !== "string" ||
    binding.origin.length > 2048 ||
    typeof binding.exposureId !== "string"
  )
    throw Error("Invalid preview binding");
  identifier(binding.exposureId);
  const url = new URL(binding.origin);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw Error("Invalid preview origin");
  return { exposureId: binding.exposureId, origin: url.origin };
}
function secret() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}
async function digest(value: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
function token(value: string): { id: string; secret: string } | undefined {
  const match = /^([a-zA-Z0-9_-]{1,128})\.([a-f0-9]{64})$/.exec(value);
  return match ? { id: match[1]!, secret: match[2]! } : undefined;
}
function valid(record: Grant, id: string): boolean {
  return (
    record.id === id &&
    Number.isSafeInteger(record.generation) &&
    record.generation > 0 &&
    Number.isSafeInteger(record.createdAt) &&
    record.createdAt >= 0 &&
    record.grantExpiresAt === record.createdAt + PREVIEW_GRANT_MS &&
    record.sessionExpiresAt === record.createdAt + PREVIEW_SESSION_MS &&
    typeof record.revoked === "boolean" &&
    (record.redemption === null ||
      (typeof record.redemption === "string" &&
        /^[a-zA-Z0-9_-]{1,128}$/.test(record.redemption))) &&
    [
      record.bootstrap,
      record.bootstrapHash,
      record.session,
      record.sessionHash,
    ].every(
      (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    )
  );
}
/** Private metadata contains replayable credentials. Never expose records through
 * generic operation results or observability. The state adapter must protect them. */
export class PreviewSessions {
  constructor(
    private readonly state: StateStore,
    private readonly operations: OperationJournal,
    private readonly ports: PortRegistry,
    private readonly now = Date.now,
  ) {}
  private key(scope: Scope, id: string) {
    return `preview-grant/${scopeKey(scope)}/${identifier(id)}`;
  }
  private permitted(
    tx: Transaction,
    scope: Scope,
    record: Grant,
    binding: PreviewBinding,
  ) {
    if (
      record.revoked ||
      record.origin !== binding.origin ||
      record.exposureId !== binding.exposureId
    )
      return false;
    try {
      return (
        this.ports.authorizeIn(tx, scope, record.exposureId).generation ===
        record.generation
      );
    } catch {
      return false;
    }
  }
  async mint(
    scope: Scope,
    id: string,
    raw: PreviewBinding,
  ): Promise<PreviewGrant> {
    identifier(id);
    const binding = normalize(raw);
    const bootstrap = secret(),
      session = secret();
    const [bootstrapHash, sessionHash] = await Promise.all([
      digest(bootstrap),
      digest(session),
    ]);
    return this.state.transaction((tx) => {
      const key = this.key(scope, id),
        prior = this.operations.getIn(tx, scope, id);
      if (prior) {
        const record = tx.get<Grant>(key);
        if (
          prior.kind !== "preview-grant" ||
          prior.phase !== "succeeded" ||
          canonical(prior.input) !== canonical(binding) ||
          !record ||
          !valid(record, id)
        )
          throw Error("Preview operation identity conflict");
        // Replay observes the original expiry and credential. It never renews it.
        return {
          id,
          token: `${id}.${record.bootstrap}`,
          expiresAt: record.grantExpiresAt,
          origin: record.origin,
        };
      }
      const authority = this.ports.authorizeIn(tx, scope, binding.exposureId);
      if (
        tx.scan(`preview-grant/${scopeKey(scope)}/`).length >=
        MAX_PREVIEW_GRANTS
      )
        throw Error("Preview grant history limit reached");
      const createdAt = this.now();
      if (
        !Number.isSafeInteger(createdAt) ||
        createdAt < 0 ||
        !Number.isSafeInteger(createdAt + PREVIEW_SESSION_MS)
      )
        throw Error("Invalid preview clock");
      const record: Grant = {
        ...binding,
        id,
        generation: authority.generation,
        createdAt,
        grantExpiresAt: createdAt + PREVIEW_GRANT_MS,
        sessionExpiresAt: createdAt + PREVIEW_SESSION_MS,
        bootstrap,
        bootstrapHash,
        session,
        sessionHash,
        redemption: null,
        revoked: false,
      };
      const fence = { ...scope, generation: authority.generation };
      this.operations.admitIn(tx, fence, id, "preview-grant", binding);
      this.operations.claimIn(tx, fence, id);
      tx.put(key, record);
      this.operations.finishIn(tx, fence, id, {
        phase: "succeeded",
        result: { grantId: id, expiresAt: record.grantExpiresAt },
        error: null,
      });
      return {
        id,
        token: `${id}.${bootstrap}`,
        expiresAt: record.grantExpiresAt,
        origin: record.origin,
      };
    });
  }
  async redeem(
    scope: Scope,
    raw: PreviewBinding,
    bootstrap: string,
    redemption: string,
  ): Promise<PreviewSession> {
    const binding = normalize(raw);
    identifier(redemption);
    const parsed = token(bootstrap);
    if (!parsed) throw Error("Preview grant unavailable");
    const hash = await digest(parsed.secret);
    return this.state.transaction((tx) => {
      const key = this.key(scope, parsed.id),
        record = tx.get<Grant>(key);
      if (
        !record ||
        !valid(record, parsed.id) ||
        record.bootstrapHash !== hash ||
        record.grantExpiresAt <= this.now() ||
        !this.permitted(tx, scope, record, binding) ||
        (record.redemption !== null && record.redemption !== redemption)
      )
        throw Error("Preview grant unavailable");
      if (record.redemption === null) tx.put(key, { ...record, redemption });
      return {
        id: record.id,
        cookie: `${record.id}.${record.session}`,
        expiresAt: record.sessionExpiresAt,
      };
    });
  }
  async authenticate(
    scope: Scope,
    raw: PreviewBinding,
    cookie: string,
  ): Promise<{ owner: string; id: string; expiresAt: number } | undefined> {
    const binding = normalize(raw),
      parsed = token(cookie);
    if (!parsed) return undefined;
    const hash = await digest(parsed.secret);
    return this.state.transaction((tx) => {
      const record = tx.get<Grant>(this.key(scope, parsed.id));
      if (
        !record ||
        !valid(record, parsed.id) ||
        record.sessionHash !== hash ||
        !record.redemption ||
        record.sessionExpiresAt <= this.now() ||
        !this.permitted(tx, scope, record, binding)
      )
        return undefined;
      return {
        owner: scope.owner,
        id: record.id,
        expiresAt: record.sessionExpiresAt,
      };
    });
  }
  async status(scope: Scope, id: string): Promise<PreviewSessionStatus> {
    return this.state.transaction((tx) => {
      const record = tx.get<Grant>(this.key(scope, id));
      if (!record || !valid(record, id))
        throw Error("Preview grant unavailable");
      return {
        id,
        exposureId: record.exposureId,
        origin: record.origin,
        generation: record.generation,
        grantExpiresAt: record.grantExpiresAt,
        sessionExpiresAt: record.sessionExpiresAt,
        redeemed: record.redemption !== null,
        revoked: record.revoked,
      };
    });
  }
  async revoke(scope: Scope, id: string, operationId: string) {
    return this.state.transaction((tx) => {
      const key = this.key(scope, id),
        record = tx.get<Grant>(key);
      if (!record || !valid(record, id))
        throw Error("Preview grant unavailable");
      const prior = this.operations.getIn(tx, scope, operationId),
        input = { grantId: id };
      if (prior) {
        if (
          prior.kind !== "preview-revoke" ||
          prior.phase !== "succeeded" ||
          canonical(prior.input) !== canonical(input)
        )
          throw Error("Preview operation identity conflict");
        return prior;
      }
      const generation = tx.get<number>(`generation/${scopeKey(scope)}`);
      if (generation === undefined) throw Error("Sandbox unavailable");
      const fence = { ...scope, generation };
      this.operations.admitIn(tx, fence, operationId, "preview-revoke", input);
      this.operations.claimIn(tx, fence, operationId);
      tx.put(key, { ...record, revoked: true });
      return this.operations.finishIn(tx, fence, operationId, {
        phase: "succeeded",
        result: { grantId: id, revoked: true },
        error: null,
      });
    });
  }
}
