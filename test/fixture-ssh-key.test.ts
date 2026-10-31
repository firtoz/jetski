import assert from "node:assert/strict";
import { test } from "node:test";
import ssh2 from "ssh2";
import { fixtureSshKey } from "../examples/fixture-ssh-key.js";

test("qualification Ed25519 serialization preserves leading zero public bytes", () => {
  let found = false;
  for (let i = 0; i < 4096; i++) {
    const seed = Buffer.alloc(32);
    seed.writeUInt32BE(i);
    const pair = fixtureSshKey(seed);
    const blob = Buffer.from(pair.public.split(" ")[1]!, "base64");
    if (blob[19] !== 0) continue;
    assert.equal(blob.readUInt32BE(15), 32);
    const pub = ssh2.utils.parseKey(pair.public),
      priv = ssh2.utils.parseKey(pair.private);
    assert.ok(!(pub instanceof Error) && !Array.isArray(pub));
    assert.ok(!(priv instanceof Error) && !Array.isArray(priv));
    assert.deepEqual(pub.getPublicSSH(), priv.getPublicSSH());
    const message = Buffer.from("leading-zero fixture");
    const signature = priv.sign(message);
    assert.ok(Buffer.isBuffer(signature));
    assert.equal(pub.verify(message, signature), true);
    found = true;
    break;
  }
  assert.ok(found, "deterministic fixture includes a leading-zero key");
});
