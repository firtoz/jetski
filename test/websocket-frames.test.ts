import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clientWebSocketFrame,
  readWebSocketEvents,
} from "../src/transport/websocket-frames.js";

async function* wire(bytes: number[] | Uint8Array, width = 1) {
  for (let i = 0; i < bytes.length; i += width)
    yield Uint8Array.from(bytes.slice(i, i + width));
}
async function decode(bytes: number[] | Uint8Array, width = 1) {
  const out = [];
  for await (const event of readWebSocketEvents(wire(bytes, width)))
    out.push(event);
  return out;
}
const close = [136, 2, 3, 232];
test("fragmented UTF8, binary and interleaved ping/pong survive byte fragmentation", async () => {
  const bytes = [
    1,
    1,
    0xe2,
    137,
    1,
    65,
    0,
    1,
    0x82,
    138,
    0,
    128,
    1,
    0xac,
    130,
    3,
    0,
    255,
    65,
    ...close,
  ];
  for (const width of [1, 2, 9, 65536]) {
    const out = await decode(bytes, width);
    assert.deepEqual(
      out.map((e) => e.kind),
      ["ping", "pong", "text", "binary", "close"],
    );
    assert.deepEqual(out[2], { kind: "text", text: "€" });
    assert.deepEqual(out[3], {
      kind: "binary",
      bytes: new Uint8Array([0, 255, 65]),
    });
  }
});
test("client frames mask exact bytes with canonical lengths and independent decoding", async () => {
  for (const length of [0, 1, 125, 126, 65535, 65536, 70001]) {
    const payload = Uint8Array.from({ length }, (_, i) => i % 256),
      encoded = clientWebSocketFrame(2, payload);
    assert.equal(encoded[0], 130);
    assert.equal((encoded[1] ?? 0) & 128, 128);
    let offset = 2,
      size = (encoded[1] ?? 0) & 127;
    if (size === 126) {
      size = new DataView(encoded.buffer).getUint16(2);
      offset += 2;
    } else if (size === 127) {
      size = Number(new DataView(encoded.buffer).getBigUint64(2));
      offset += 8;
    }
    assert.equal(size, length);
    const decoded = new Uint8Array(length);
    for (let i = 0; i < length; i++)
      decoded[i] =
        (encoded[offset + 4 + i] ?? 0) ^ (encoded[offset + (i % 4)] ?? 0);
    assert.deepEqual(decoded, payload);
    const unmasked = [
      130,
      ...(length < 126
        ? [length]
        : length < 65536
          ? [126, length >>> 8, length & 255]
          : [
              127,
              0,
              0,
              0,
              0,
              (length >>> 24) & 255,
              (length >>> 16) & 255,
              (length >>> 8) & 255,
              length & 255,
            ]),
      ...payload,
      ...close,
    ];
    assert.deepEqual((await decode(unmasked, 777))[0], {
      kind: "binary",
      bytes: payload,
    });
  }
});
test("invalid masks, opcodes, lengths, UTF8, control and close frames fail closed", async () => {
  for (const raw of [
    [130, 128, 0, 0, 0, 0],
    [194, 0],
    [131, 0],
    [128, 0],
    [2, 0, 130, 0],
    [137, 126],
    [9, 0],
    [130, 126, 0, 1, 0],
    [130, 127, 0, 0, 0, 0, 0, 0, 0, 1],
    [130, 127, 0, 0, 0, 1, 0, 0, 0, 0],
    [130, 3, 1],
    [129, 1, 255],
    [129, 2, 0xc0, 0x80],
    [136, 1, 0],
    [136, 2, 3, 237],
    [136, 2, 3, 231],
    [136, 3, 3, 232, 255],
    [...close, 130, 0],
    [130, 0],
  ])
    await assert.rejects(decode(raw));
  assert.throws(() => clientWebSocketFrame(8, new Uint8Array([3, 237])));
  assert.throws(() => clientWebSocketFrame(9, new Uint8Array(126)));
  assert.throws(() => clientWebSocketFrame(1, new Uint8Array([255])));
});

test("UTF8 BOM is message content and fragmented-message limits are enforced", async () => {
  const out = await decode([129, 4, 239, 187, 191, 65, ...close]);
  assert.deepEqual(out[0], { kind: "text", text: "\uFEFFA" });
  await assert.rejects(decode([130, 127, 0, 0, 0, 0, 0, 128, 0, 1]), /limit/);
  const fragments = [2, 0];
  for (let i = 0; i < 4096; i++) fragments.push(0, 0);
  await assert.rejects(decode(fragments), /limit/);
});
