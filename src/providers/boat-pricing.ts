import { identifier } from "../core/contracts.js";
import {
  HOST_LIFECYCLE_LIMITS,
  type IdlePriceSource,
  idlePriceQuote,
} from "../core/host-lifecycle.js";
import type { BoatApi, BoatMachineType } from "./boat.js";

const SIZE_RATE: Record<BoatMachineType, number> = {
  small: 0.5,
  default: 1,
  large: 2,
};

/** Controller-only quote. The budget is an operator's per-idle-decision cap,
 * not a statement about wallet balance or an automatic spending authorization. */
export class BoatIdlePriceSource implements IdlePriceSource {
  constructor(
    private readonly api: BoatApi,
    private readonly machine: BoatMachineType,
    private readonly idleBudgetMicros: number,
  ) {
    if (
      !Object.hasOwn(SIZE_RATE, machine) ||
      !Number.isSafeInteger(idleBudgetMicros) ||
      idleBudgetMicros < 0 ||
      idleBudgetMicros > HOST_LIFECYCLE_LIMITS.maxMoneyMicros
    )
      throw Error("Invalid Boat idle pricing configuration");
  }
  async quote(input: Parameters<IdlePriceSource["quote"]>[0]) {
    identifier(input.owner);
    const response = await this.api.call(
      "/limits",
      "GET",
      undefined,
      {},
      {
        maxBytes: 128 * 1024,
        timeoutMs: HOST_LIFECYCLE_LIMITS.priceRequestMs,
        signal: input.signal,
      },
    );
    if (response.status !== 200) throw Error("Boat idle pricing unavailable");
    const data = response.value,
      prices = data.overagePrices;
    // Null means a start would fail; do not invent an effective monetary quote.
    if (data.nextStartDollars === null) return undefined;
    if (
      !prices ||
      typeof prices !== "object" ||
      Array.isArray(prices) ||
      typeof prices.vmHourDollars !== "number" ||
      !Number.isFinite(prices.vmHourDollars) ||
      prices.vmHourDollars < 0 ||
      typeof data.nextStartDollars !== "number" ||
      !Number.isFinite(data.nextStartDollars) ||
      data.nextStartDollars < 0
    )
      throw Error("Invalid Boat idle pricing response");
    return idlePriceQuote({
      currency: "USD",
      observedAt: input.now,
      validUntil: input.now + HOST_LIFECYCLE_LIMITS.maxQuoteAgeMs,
      computeMicrosPerHour: Math.round(
        prices.vmHourDollars * SIZE_RATE[this.machine] * 1_000_000,
      ),
      avoidedStartMicros: Math.round(data.nextStartDollars * 1_000_000),
      remainingIdleBudgetMicros: this.idleBudgetMicros,
    });
  }
}
