import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeStreamFrame as encode,
  STREAM_DATA_BYTES,
  StreamDecoder,
  type StreamFrame,
} from "../src/core/stream-protocol.js";

const ready = encode({ kind: "ready" });
const fin = encode({ kind: "fin" });
const data = new Uint8Array(STREAM_DATA_BYTES).map((_, i) => i % 251);
const encoded = encode({ kind: "data", bytes: data });

test("relay decoder handles fragmented and coalesced exact binary frames", () => {
  const wire = Buffer.concat([ready, encoded, encoded, fin]);
  for (const size of [1, 3, 5, 4096, wire.length]) {
    const decoder = new StreamDecoder(true),
      frames: StreamFrame[] = [];
    for (let at = 0; at < wire.length; at += size)
      frames.push(...decoder.feed(wire.subarray(at, at + size)));
    decoder.finish();
    assert.deepEqual(frames, [
      { kind: "ready" },
      { kind: "data", bytes: data },
      { kind: "data", bytes: data },
      { kind: "fin" },
    ]);
  }
  const input = new StreamDecoder(false);
  assert.deepEqual([...input.feed(fin)], [{ kind: "fin" }]);
  input.finish();
});

test("relay decoder rejects invalid direction, bounds and truncated streams", () => {
  for (const [output, wire] of [
    [false, ready],
    [true, encoded],
    [true, fin],
    [true, Buffer.concat([ready, ready])],
    [false, Buffer.concat([fin, encoded])],
    [false, new Uint8Array([68, 0, 0, 0, 0])],
    [false, new Uint8Array([68, 0, 0, 64, 1])],
    [false, new Uint8Array([70, 0, 0, 0, 1])],
    [false, new Uint8Array([99, 0, 0, 0, 0])],
    [false, new Uint8Array(1024 * 1024 + 1)],
  ] as const) {
    const decoder = new StreamDecoder(output);
    assert.throws(() => [...decoder.feed(wire)]);
    assert.throws(() => [...decoder.feed(fin)]);
    assert.throws(() => decoder.finish());
  }
  for (const length of [0, 1, 4, 5, 6, encoded.length]) {
    const decoder = new StreamDecoder(false);
    [...decoder.feed(encoded.subarray(0, length))];
    assert.throws(() => decoder.finish(), /completion unknown/);
  }
  assert.throws(() => encode({ kind: "data", bytes: new Uint8Array() }));
  assert.throws(() =>
    encode({ kind: "data", bytes: new Uint8Array(STREAM_DATA_BYTES + 1) }),
  );
});

test("abandoning a frame iterator cannot silently discard input", () => {
  const decoder = new StreamDecoder(false);
  for (const _ of decoder.feed(Buffer.concat([encoded, fin]))) break;
  assert.throws(() => decoder.finish());
  assert.throws(() => [...decoder.feed(fin)]);
});

test("decoded data is independent of input and reused pending storage", () => {
  const decoder = new StreamDecoder(false);
  const wire = encode({ kind: "data", bytes: data });
  const first = [...decoder.feed(wire)];
  wire.fill(0);
  [
    ...decoder.feed(
      encode({ kind: "data", bytes: new Uint8Array(data.length).fill(255) }),
    ),
  ];
  [...decoder.feed(fin)];
  decoder.finish();
  assert.deepEqual(first, [{ kind: "data", bytes: data }]);
});
