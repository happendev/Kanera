import { createHash, randomBytes, randomInt } from "node:crypto";

export function newOpaqueToken(bytes = 32) {
  const raw = randomBytes(bytes).toString("base64url");
  return { raw, hash: hashOpaqueToken(raw) };
}

export function hashOpaqueToken(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

// A 6-digit numeric email-verification code. randomInt is cryptographically
// secure and uniform; the code is hashed (like opaque tokens) so it is never
// stored in plaintext. Its low entropy is mitigated by short expiry + attempt
// caps + send rate limiting at the call sites, not by the hash.
export function newVerificationCode() {
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  return { code, hash: hashOpaqueToken(code) };
}
