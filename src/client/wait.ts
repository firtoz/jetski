import type { Operation } from "../core/contracts.js";

export const OPERATION_WAIT_LIMITS = {
  defaultMs: 600000,
  maxMs: 3600000,
  pollMs: 250,
} as const;

/** Abortable observation delay; never changes remote lifecycle state. */
export async function observationDelay(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, OPERATION_WAIT_LIMITS.pollMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      signal.removeEventListener("abort", abort);
      abort();
    }
  });
}

export type OperationWaitOptions = {
  /** Bounds observation only. Timeout/abort never cancels or restarts remote work. */
  waitTimeoutMs?: number;
  signal?: AbortSignal;
};
export class OperationOutcomeError extends Error {
  constructor(readonly operation: Operation) {
    super(
      `Operation ${operation.id} is ${operation.phase}; observe its existing identity before any retry`,
    );
    this.name = "OperationOutcomeError";
  }
}
/** GET/observation only: no admission, reconciliation or mutation retries. */
export async function observeOperation(
  sandbox: string,
  id: string,
  observe: (signal: AbortSignal) => Promise<Operation>,
  options: OperationWaitOptions = {},
): Promise<Operation> {
  const timeout = options.waitTimeoutMs ?? OPERATION_WAIT_LIMITS.defaultMs;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > OPERATION_WAIT_LIMITS.maxMs
  )
    throw Error("Invalid operation observation timeout");
  const deadline = AbortSignal.timeout(timeout);
  const signal = options.signal
    ? AbortSignal.any([deadline, options.signal])
    : deadline;
  while (true) {
    signal.throwIfAborted();
    const operation = await observe(signal);
    signal.throwIfAborted();
    if (operation.id !== id || operation.sandbox !== sandbox)
      throw Error("Operation observation identity mismatch");
    switch (operation.phase) {
      case "succeeded":
        return operation;
      case "failed":
      case "uncertain":
        throw new OperationOutcomeError(operation);
      case "queued":
      case "running":
        break;
      default:
        throw Error("Invalid operation observation phase");
    }
    await observationDelay(signal);
  }
}
