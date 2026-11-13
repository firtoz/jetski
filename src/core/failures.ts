export const JETSKI_FAILURE_CODES = [
  "stale-generation",
  "unsupported-capability",
] as const;
export type JetskiFailureCode = (typeof JETSKI_FAILURE_CODES)[number];
/** Explicit contract rejection; never a retry or runtime fallback instruction. */
export class JetskiContractError extends Error {
  constructor(
    readonly code: JetskiFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "JetskiContractError";
  }
}
