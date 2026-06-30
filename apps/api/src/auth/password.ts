import argon2 from "argon2";

const PASSWORD_HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
} satisfies Parameters<typeof argon2.hash>[1];

export const hashPassword = (plain: string) => argon2.hash(plain, PASSWORD_HASH_OPTIONS);

export const verifyPassword = (hash: string, plain: string) => argon2.verify(hash, plain);

export const needsPasswordRehash = (hash: string) => argon2.needsRehash(hash, PASSWORD_HASH_OPTIONS);

// Precomputed once on first use so the no-user login path still performs a real argon2
// verification. Without this, a missing account returns measurably faster than a wrong
// password, leaking which emails are registered. The plaintext is irrelevant.
let dummyHashPromise: Promise<string> | null = null;

// Verify `plain` against `hash`, or against a dummy hash when `hash` is null, always returning
// false in the null case. Callers use this on login so timing does not reveal account existence.
export async function verifyPasswordTimingSafe(hash: string | null, plain: string): Promise<boolean> {
  if (!dummyHashPromise) dummyHashPromise = hashPassword("kanera-timing-equalizer");
  const target = hash ?? (await dummyHashPromise);
  const matched = await verifyPassword(target, plain);
  return hash !== null && matched;
}
