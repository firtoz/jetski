/** A service rejection. Status is machine-readable; no message parsing required. */
export class JetskiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code?: import("../core/failures.js").JetskiFailureCode,
  ) {
    super(`Jetski request failed (${status})`);
    this.name = "JetskiHttpError";
  }
}
