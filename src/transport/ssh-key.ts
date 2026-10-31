/** Controller-side OpenSSH Ed25519 serialization. Keep private keys outside workloads. */
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";

function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}
function field(bytes: Buffer): Buffer {
  return Buffer.concat([uint32(bytes.length), bytes]);
}
/** Serialize fixed-width Ed25519 bytes without integer-style zero trimming. */
export function sshKeyPair(seed = randomBytes(32)) {
  if (seed.length !== 32) throw Error("Ed25519 seed must be 32 bytes");
  const key = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]),
    format: "der",
    type: "pkcs8",
  });
  const jwk = createPublicKey(key).export({ format: "jwk" });
  if (!jwk.x) throw Error("Missing Ed25519 public key");
  const publicBytes = Buffer.from(jwk.x, "base64url");
  if (publicBytes.length !== 32) throw Error("Invalid Ed25519 public key");
  const type = Buffer.from("ssh-ed25519");
  const publicBlob = Buffer.concat([field(type), field(publicBytes)]);
  const check = randomBytes(4);
  const privateBlob = Buffer.concat([
    check,
    check,
    field(type),
    field(publicBytes),
    field(Buffer.concat([seed, publicBytes])),
    field(Buffer.alloc(0)),
  ]);
  const padding = Buffer.from(
    Array.from({ length: 8 - (privateBlob.length % 8) }, (_, i) => i + 1),
  );
  const envelope = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    field(Buffer.from("none")),
    field(Buffer.from("none")),
    field(Buffer.alloc(0)),
    uint32(1),
    field(publicBlob),
    field(Buffer.concat([privateBlob, padding])),
  ]).toString("base64");
  return {
    public: `ssh-ed25519 ${publicBlob.toString("base64")}`,
    private: `-----BEGIN OPENSSH PRIVATE KEY-----\n${envelope.match(/.{1,70}/g)!.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`,
  };
}
