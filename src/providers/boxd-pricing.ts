import { identifier } from "../core/contracts.js";
import {
  HOST_LIFECYCLE_LIMITS,
  type IdleCurrency,
  type IdlePriceSource,
  idlePriceQuote,
} from "../core/host-lifecycle.js";

/** Account rates and a declared resource bound, not an invoice or wallet balance. */
export type BoxdIdleRates = {
  currency: string;
  rates: {
    vcpuHourMicro: number;
    ramGibHourMicro: number;
    diskGibHourMicro: number;
  };
};
export type BoxdIdlePricing = {
  currency: IdleCurrency;
  maxIdleSpendMicros: number;
  /** Operator's disk allocation estimate; include retained local checkpoint bytes. */
  diskGiB: number;
};
/** Injected rate reader must obey the supplied abort signal and bounded deadline.
 * CPU/RAM are priced at configured capacity, conservatively above ordinary idle
 * usage. Native sleep economics are separate; no invented avoided start fee. */
export class BoxdIdlePriceSource implements IdlePriceSource {
  constructor(
    private readRates: (signal: AbortSignal) => Promise<BoxdIdleRates>,
    private resources: { vcpu: number; memoryGiB: number },
    private policy: BoxdIdlePricing,
  ) {
    for (const value of [resources.vcpu, resources.memoryGiB, policy.diskGiB])
      if (!Number.isFinite(value) || value <= 0 || value > 65536)
        throw Error("Invalid boxd pricing resource bound");
    idlePriceQuote({
      currency: policy.currency,
      observedAt: 0,
      validUntil: 0,
      computeMicrosPerHour: 0,
      avoidedStartMicros: 0,
      remainingIdleBudgetMicros: policy.maxIdleSpendMicros,
    });
  }
  async quote(input: Parameters<IdlePriceSource["quote"]>[0]) {
    identifier(input.owner);
    input.signal.throwIfAborted();
    const value = await this.readRates(input.signal);
    input.signal.throwIfAborted();
    if (
      typeof value.currency !== "string" ||
      value.currency.toUpperCase() !== this.policy.currency
    )
      throw Error("boxd pricing currency does not match idle budget");
    for (const rate of Object.values(value.rates))
      if (
        !Number.isSafeInteger(rate) ||
        rate < 0 ||
        rate > HOST_LIFECYCLE_LIMITS.maxMoneyMicros
      )
        throw Error("Invalid boxd rate");
    const hourly = Math.ceil(
      value.rates.vcpuHourMicro * this.resources.vcpu +
        value.rates.ramGibHourMicro * this.resources.memoryGiB +
        value.rates.diskGibHourMicro * this.policy.diskGiB,
    );
    return idlePriceQuote({
      currency: this.policy.currency,
      observedAt: input.now,
      validUntil: input.now + HOST_LIFECYCLE_LIMITS.maxQuoteAgeMs,
      computeMicrosPerHour: hourly,
      avoidedStartMicros: 0,
      remainingIdleBudgetMicros: this.policy.maxIdleSpendMicros,
    });
  }
}
