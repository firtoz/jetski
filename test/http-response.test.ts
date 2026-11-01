import assert from "node:assert/strict";
import { test } from "node:test";
import { readHttpResponse } from "../src/transport/http-response.js";

async function* wire(text: string, width = 1) {
  const bytes = Buffer.from(text, "latin1");
  for (let i = 0; i < bytes.length; i += width)
    yield bytes.subarray(i, i + width);
}
async function decode(text: string, method = "GET", width = 1) {
  const response = await readHttpResponse(wire(text, width), method);
  const parts = [];
  for await (const part of response.body) parts.push(part);
  return { status: response.status, body: Buffer.concat(parts) };
}
test("fragmented HTTP fixed, close-delimited, informational and chunked binary bodies", async () => {
  for (const width of [1, 2, 7, 65536]) {
    assert.deepEqual(
      (
        await decode(
          "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n\x00\xffA",
          "GET",
          width,
        )
      ).body,
      Buffer.from([0, 255, 65]),
    );
    assert.equal(
      (
        await decode(
          'HTTP/1.1 103 Early Hints\r\nLink: </a>\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3;foo="bar"\r\nabc\r\n2\r\nde\r\n0\r\nX-Checksum: ignored\r\n\r\n',
          "GET",
          width,
        )
      ).body.toString(),
      "abcde",
    );
    assert.equal(
      (
        await decode("HTTP/1.0 200 OK\r\n\r\nbye", "GET", width)
      ).body.toString(),
      "bye",
    );
  }
});
test("bodyless responses preserve representation length without reading a body", async () => {
  assert.equal(
    (
      await decode(
        "HTTP/1.1 200 OK\r\nContent-Length: 999999999\r\n\r\n",
        "HEAD",
      )
    ).body.length,
    0,
  );
  assert.equal(
    (await decode("HTTP/1.1 304 Not Modified\r\nContent-Length: 20\r\n\r\n"))
      .body.length,
    0,
  );
  assert.equal(
    (await decode("HTTP/1.1 204 No Content\r\n\r\n")).body.length,
    0,
  );
});
test("ambiguous framing, truncation, folding and trailing bytes fail closed", async () => {
  for (const raw of [
    "Content-Length: 1\r\nContent-Length: 1\r\n\r\nx",
    "Content-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\nx",
    "Content-Length: 1, 1\r\n\r\nx",
    "Content-Length: 3\r\n\r\nx",
    "Content-Length: 1\r\n\r\nxy",
    "Transfer-Encoding: gzip, chunked\r\n\r\n",
    "Transfer-Encoding: chunked\r\n\r\n2\r\na",
    "Transfer-Encoding: chunked\r\n\r\n1\r\naX\r\n0\r\n\r\n",
    "Transfer-Encoding: chunked\r\n\r\n0\r\nContent-Length: 1\r\n\r\n",
    "X: a\r\n folded\r\n\r\n",
    "X : bad\r\n\r\n",
    "X: bad\x00value\r\n\r\n",
  ])
    await assert.rejects(decode(`HTTP/1.1 200 OK\r\n${raw}`));
  await assert.rejects(decode("HTTP/1.1 200 OK\n\n"));
  await assert.rejects(decode("HTTP/1.1 101 Switching Protocols\r\n\r\n"));
  await assert.rejects(
    decode("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n"),
  );
  await assert.rejects(
    decode("HTTP/1.1 200 OK\r\nX: " + "a".repeat(32768) + "\r\n\r\n"),
  );
  await assert.rejects(
    decode("HTTP/1.1 200 OK\r\nContent-Length: 67108865\r\n\r\n"),
  );
});
