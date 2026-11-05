import { DEFAULTS } from "./contracts.js";
import { HOST_IDLE_MODES, type HostIdleMode } from "./host-power.js";

export const HOST_LIFECYCLE_LIMITS = Object.freeze({
  maxLifetimeMs: 24 * 60 * 60_000,
  maxIdleMs: 2 * 60 * 60_000,
  maxQuoteAgeMs: 5 * 60_000,
  historySamples: 32,
  maxMoneyMicros: 1_000_000_000,
  maintenanceRetryMs: 1_000,
  priceRequestMs: 2_000,
  priceRetryMs: 30_000,
});

export const IDLE_CURRENCIES = ["USD", "EUR"] as const;
export type IdleCurrency = (typeof IDLE_CURRENCIES)[number];

export type IdleRetention =
  | { mode: "fixed"; timeoutMs: number }
  | {
      mode: "adaptive";
      /** Omitted persisted v1 policies are USD. Never converted implicitly. */
      currency?: IdleCurrency;
      minMs: number;
      maxMs: number;
      fallbackMs: number;
      maxIdleSpendMicros: number;
    };

/** Operator configuration. Provider limits are checked independently. */
export type HostLifecycle = {
  /** Opt-in native host sleep, only after durable release. */
  nativeIdle?: { mode: HostIdleMode; afterMs: number };
  lifetimeMs: number;
  drainMs: number;
  idle: IdleRetention;
};

/** A caller supplies a bounded effective quote outside the state transaction.
 * Money is integer millionths of the declared currency; no credential/network dependency. */
export type IdlePriceQuote = {
  /** Missing in persisted v1 quotes means USD. */
  currency?: IdleCurrency;
  observedAt: number;
  validUntil: number;
  computeMicrosPerHour: number;
  avoidedStartMicros: number;
  remainingIdleBudgetMicros: number;
};

/** Trusted controller-side source. It has no authority over leases or workloads. */
export interface IdlePriceSource {
  quote(input: {
    owner: string;
    now: number;
    signal: AbortSignal;
  }): Promise<IdlePriceQuote | undefined>;
}

export type IdleDecision = {
  idleSince: number;
  retireAt: number;
  reason: "fixed" | "fallback" | "adaptive" | "budget" | "drain";
  reservedIdleCostMicros: number | null;
};

function integer(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw Error(`Invalid host lifecycle ${label}`);
  return value;
}

export function hostLifecycle(input?: HostLifecycle): HostLifecycle {
  const value = input ?? {
    lifetimeMs: DEFAULTS.hostLifetimeMs,
    drainMs: DEFAULTS.hostDrainMs,
    idle: { mode: "fixed", timeoutMs: DEFAULTS.idleMs },
  };
  if (value.nativeIdle !== undefined) {
    if (!HOST_IDLE_MODES.includes(value.nativeIdle.mode))
      throw Error("Invalid native idle mode");
    integer(
      value.nativeIdle.afterMs,
      0,
      HOST_LIFECYCLE_LIMITS.maxIdleMs,
      "native idle delay",
    );
  }
  const lifetimeMs = integer(
    value.lifetimeMs,
    1,
    HOST_LIFECYCLE_LIMITS.maxLifetimeMs,
    "lifetime",
  );
  const drainMs = integer(value.drainMs, 1, lifetimeMs - 1, "drain");
  const maxIdle = Math.min(
    HOST_LIFECYCLE_LIMITS.maxIdleMs,
    lifetimeMs - drainMs,
  );
  if (value.idle.mode === "fixed") {
    return {
      ...(value.nativeIdle ? { nativeIdle: { ...value.nativeIdle } } : {}),
      lifetimeMs,
      drainMs,
      idle: {
        mode: "fixed",
        timeoutMs: integer(value.idle.timeoutMs, 0, maxIdle, "idle timeout"),
      },
    };
  }
  if (value.idle.mode !== "adaptive")
    throw Error("Invalid host lifecycle idle mode");
  if (
    value.idle.currency !== undefined &&
    !IDLE_CURRENCIES.includes(value.idle.currency)
  )
    throw Error("Invalid idle budget currency");
  const minMs = integer(value.idle.minMs, 0, maxIdle, "minimum idle");
  const maxMs = integer(value.idle.maxMs, minMs, maxIdle, "maximum idle");
  return {
    ...(value.nativeIdle ? { nativeIdle: { ...value.nativeIdle } } : {}),
    lifetimeMs,
    drainMs,
    idle: {
      mode: "adaptive",
      ...(value.idle.currency === undefined
        ? {}
        : { currency: value.idle.currency }),
      minMs,
      maxMs,
      fallbackMs: integer(value.idle.fallbackMs, minMs, maxMs, "fallback idle"),
      maxIdleSpendMicros: integer(
        value.idle.maxIdleSpendMicros,
        0,
        HOST_LIFECYCLE_LIMITS.maxMoneyMicros,
        "idle budget",
      ),
    },
  };
}

export function idlePriceQuote(input: IdlePriceQuote): IdlePriceQuote {
  if (input.currency !== undefined && !IDLE_CURRENCIES.includes(input.currency))
    throw Error("Invalid idle quote currency");
  integer(input.observedAt, 0, Number.MAX_SAFE_INTEGER, "quote time");
  integer(
    input.validUntil,
    input.observedAt,
    Math.min(
      Number.MAX_SAFE_INTEGER,
      input.observedAt + HOST_LIFECYCLE_LIMITS.maxQuoteAgeMs,
    ),
    "quote expiry",
  );
  for (const key of [
    "computeMicrosPerHour",
    "avoidedStartMicros",
    "remainingIdleBudgetMicros",
  ] as const)
    integer(input[key], 0, HOST_LIFECYCLE_LIMITS.maxMoneyMicros, key);
  return {
    ...(input.currency === undefined ? {} : { currency: input.currency }),
    observedAt: input.observedAt,
    validUntil: input.validUntil,
    computeMicrosPerHour: input.computeMicrosPerHour,
    avoidedStartMicros: input.avoidedStartMicros,
    remainingIdleBudgetMicros: input.remainingIdleBudgetMicros,
  };
}

/** Pure default policy. History includes cold misses as well as cache hits, so
 * retiring early cannot censor the samples into a false short-return prediction.
 * The journal persists this decision; maintenance must not restart its clock. */
export function decideIdleRetention(input: {
  policy: HostLifecycle;
  idleSince: number;
  expiresAt: number;
  returnGapsMs: readonly number[];
  quote?: IdlePriceQuote | undefined;
}): IdleDecision {
  const policy = hostLifecycle(input.policy);
  const start = integer(
    input.idleSince,
    0,
    Number.MAX_SAFE_INTEGER,
    "idle start",
  );
  const expires = integer(
    input.expiresAt,
    0,
    Number.MAX_SAFE_INTEGER,
    "host expiry",
  );
  const drainAt = Math.max(start, expires - policy.drainMs);
  if (drainAt === start)
    return {
      idleSince: start,
      retireAt: start,
      reason: "drain",
      reservedIdleCostMicros: 0,
    };
  if (policy.idle.mode === "fixed")
    return {
      idleSince: start,
      retireAt: Math.min(drainAt, start + policy.idle.timeoutMs),
      reason: "fixed",
      reservedIdleCostMicros: null,
    };
  const idle = policy.idle;
  const quote =
    input.quote === undefined ? undefined : idlePriceQuote(input.quote);
  if (
    !quote ||
    (quote.currency ?? "USD") !== (idle.currency ?? "USD") ||
    quote.observedAt > start ||
    quote.validUntil <= start
  )
    return {
      idleSince: start,
      retireAt: Math.min(drainAt, start + idle.fallbackMs),
      reason: "fallback",
      reservedIdleCostMicros: null,
    };
  const gaps = input.returnGapsMs.slice(-HOST_LIFECYCLE_LIMITS.historySamples);
  for (const gap of gaps)
    integer(gap, 0, Number.MAX_SAFE_INTEGER, "return gap");
  const rate = quote.computeMicrosPerHour;
  const budget = Math.min(
    idle.maxIdleSpendMicros,
    quote.remainingIdleBudgetMicros,
  );
  const affordableMs =
    rate === 0 ? idle.maxMs : Math.floor((budget * 3_600_000) / rate);
  const cap = Math.min(idle.maxMs, affordableMs, drainAt - start);
  // Spending caps and hard expiry override even the latency floor.
  if (cap < idle.minMs)
    return {
      idleSince: start,
      retireAt: start,
      reason: "budget",
      reservedIdleCostMicros: 0,
    };
  let duration = Math.min(idle.fallbackMs, cap);
  if (gaps.length >= 2) {
    const choices = [
      ...new Set([
        idle.minMs,
        cap,
        ...gaps.map((gap) => Math.max(idle.minMs, Math.min(cap, gap))),
      ]),
    ].sort((a, b) => a - b);
    let best = Number.NEGATIVE_INFINITY;
    for (const choice of choices) {
      const probability =
        gaps.filter((gap) => gap <= choice).length / gaps.length;
      const benefit =
        probability * quote.avoidedStartMicros - (rate * choice) / 3_600_000;
      if (benefit > best) {
        duration = choice;
        best = benefit;
      }
    }
  } else if (quote.avoidedStartMicros === 0) duration = idle.minMs;
  return {
    idleSince: start,
    retireAt: start + duration,
    reason: "adaptive",
    reservedIdleCostMicros: Math.ceil((rate * duration) / 3_600_000),
  };
}
