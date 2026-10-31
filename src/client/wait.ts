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
    }, 250);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      signal.removeEventListener("abort", abort);
      abort();
    }
  });
}
