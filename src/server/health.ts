/** Observational scheduler health, never lifecycle authority or an auto-retry. */
export class ServiceHealth {
  private lastSuccess: number | null = null;
  private lastFailure: number | null = null;
  private stopping = false;
  constructor(private readonly now = Date.now) {}
  succeeded() {
    this.lastSuccess = this.now();
  }
  failed() {
    this.lastFailure = this.now();
  }
  stop() {
    this.stopping = true;
  }
  snapshot() {
    return {
      ready:
        !this.stopping &&
        this.lastSuccess !== null &&
        this.now() - this.lastSuccess < 30000 &&
        (this.lastFailure === null || this.lastSuccess > this.lastFailure),
      stopping: this.stopping,
      lastSuccess: this.lastSuccess,
      lastFailure: this.lastFailure,
    };
  }
}
