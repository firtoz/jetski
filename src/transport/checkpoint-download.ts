/** Consume contiguous archive reads through one bounded stream. Sparse reads keep
 * the independently verified range transport; no archive-sized buffering. */
export function sequentialCheckpointDownload(
  length: number,
  range: (offset: number, bytes: number) => Promise<Uint8Array>,
  open: () => Promise<Response>,
) {
  let started = false,
    closed = false,
    cursor = 0,
    received = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let pending: Uint8Array = new Uint8Array(0);
  let queue = Promise.resolve();
  let failure: { reason: unknown } | undefined;
  const cancel = async () => {
    pending = new Uint8Array(0);
    await reader?.cancel();
    reader = undefined;
  };
  async function read(offset: number, count: number) {
    if (closed) throw Error("Checkpoint download closed");
    if (failure) throw failure.reason;
    if (!started && offset !== 0) return range(offset, count);
    // Mark synchronously so concurrent reads join the same ordered stream.
    const first = !started;
    started = true;
    let result!: Uint8Array;
    const work = queue.then(async () => {
      if (failure) throw failure.reason;
      if (closed) throw Error("Checkpoint download closed");
      try {
        if (first) {
          const response = await open();
          const size = response.headers.get("content-length");
          const encoding = response.headers.get("content-encoding");
          if (
            response.status !== 200 ||
            !response.body ||
            (size !== null && size !== String(length)) ||
            (encoding && encoding !== "identity")
          ) {
            await response.body?.cancel();
            throw Error("Invalid checkpoint stream metadata");
          }
          reader = response.body.getReader();
        }
        if (!reader || offset !== cursor) {
          await cancel();
          result = await range(offset, count);
          return;
        }
        result = new Uint8Array(count);
        let copied = 0;
        while (copied < count) {
          if (!pending.length) {
            const next = await reader.read();
            if (next.done) throw Error("Short checkpoint stream");
            received += next.value.length;
            if (next.value.length > 8 * 1024 * 1024 || received > length)
              throw Error("Oversized checkpoint stream");
            pending = next.value;
          }
          const take = Math.min(pending.length, count - copied);
          result.set(pending.subarray(0, take), copied);
          pending = pending.subarray(take);
          cursor += take;
          copied += take;
        }
        if (cursor === length) {
          if (pending.length || !(await reader.read()).done)
            throw Error("Oversized checkpoint stream");
          await cancel();
        }
      } catch (reason) {
        failure = { reason };
        await cancel();
        throw reason;
      }
    });
    queue = work.catch(() => undefined);
    await work;
    return result;
  }
  return {
    read,
    async close() {
      await queue;
      closed = true;
      await cancel();
    },
  };
}
