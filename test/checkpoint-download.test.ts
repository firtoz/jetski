import assert from "node:assert/strict";
import { test } from "node:test";
import { sequentialCheckpointDownload } from "../src/transport/checkpoint-download.js";

test("contiguous concurrent reads share one stream and sparse offsets retain ranges", async () => {
  const content = Uint8Array.from({ length: 100 }, (_, i) => i);
  let streams = 0,
    ranges = 0,
    cancellations = 0;
  const make = () =>
    sequentialCheckpointDownload(
      content.length,
      async (offset, count) => {
        ranges++;
        return content.slice(offset, offset + count);
      },
      async () => {
        streams++;
        let offset = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (offset === content.length) return controller.close();
              controller.enqueue(content.slice(offset, offset + 7));
              offset = Math.min(content.length, offset + 7);
            },
            cancel() {
              cancellations++;
            },
          }),
        );
      },
    );
  const source = make();
  const chunks = await Promise.all([
    source.read(0, 25),
    source.read(25, 25),
    source.read(50, 25),
    source.read(75, 25),
  ]);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(content));
  assert.equal(streams, 1);
  assert.equal(ranges, 0);
  await source.close();
  await assert.rejects(source.read(0, 1), /closed/);
  const sparse = make();
  assert.deepEqual(await sparse.read(0, 10), content.slice(0, 10));
  assert.deepEqual(await sparse.read(50, 10), content.slice(50, 60));
  await sparse.close();
  assert.equal(ranges, 1);
  assert.equal(cancellations, 1);
});

test("truncation, excess and metadata faults poison queued reads and close the source", async () => {
  for (const fault of ["short", "long", "redirect", "encoding", "length"]) {
    let ranged = 0;
    const bytes = new Uint8Array(fault === "short" ? 7 : 11);
    const source = sequentialCheckpointDownload(
      10,
      async () => {
        ranged++;
        return new Uint8Array(1);
      },
      async () =>
        new Response(bytes, {
          status: fault === "redirect" ? 302 : 200,
          headers: {
            ...(fault === "encoding" ? { "content-encoding": "gzip" } : {}),
            ...(fault === "length" ? { "content-length": "11" } : {}),
          },
        }),
    );
    const result = await Promise.allSettled([
      source.read(0, 5),
      source.read(5, 5),
    ]);
    assert.ok(
      result.some((row) => row.status === "rejected"),
      fault,
    );
    await assert.rejects(source.read(0, 1));
    await source.close();
    assert.equal(ranged, 0);
  }
});
