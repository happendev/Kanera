import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mfaCredentials, mfaRecoveryCodes } from "@kanera/shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import * as OTPAuth from "otpauth";
import { db } from "../db.js";
import { env } from "../env.js";

type Identity = { kind: "user" | "admin"; id: string };
type ChallengePurpose = "verify" | "enroll";
const KEY = createHash("sha256").update(env.MFA_ENCRYPTION_KEY).digest();
const ISSUER = "Kanera";
const TOTP_PERIOD = 30;
// Per-credential second-factor lockout. Mirrors the admin password lockout so a static 6-digit
// secret cannot be brute-forced across rotating IPs (the per-IP limiter fails open on cache loss).
const MAX_MFA_ATTEMPTS = 5;
const MFA_LOCK_MS = 5 * 60_000;

function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["mfav1", iv.toString("base64url"), encrypted.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

function decrypt(value: string): string {
  const [version, iv, ciphertext, tag] = value.split(".");
  if (version !== "mfav1" || !iv || !ciphertext || !tag) throw new Error("invalid encrypted MFA secret");
  const decipher = createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

const ownerWhere = (identity: Identity) => identity.kind === "user"
  ? eq(mfaCredentials.userId, identity.id)
  : eq(mfaCredentials.adminUserId, identity.id);

export async function getMfaCredential(identity: Identity) {
  const [row] = await db.select().from(mfaCredentials).where(ownerWhere(identity)).limit(1);
  return row ?? null;
}

export function createMfaChallenge(identity: Identity, purpose: ChallengePurpose): string {
  const payload = Buffer.from(JSON.stringify({ ...identity, purpose, exp: Date.now() + 5 * 60_000 })).toString("base64url");
  return `${payload}.${createHmac("sha256", KEY).update(payload).digest("base64url")}`;
}

export function readMfaChallenge(token: string, kind: Identity["kind"], purpose?: ChallengePurpose): Identity & { purpose: ChallengePurpose } {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) throw new Error("invalid challenge");
  const expected = createHmac("sha256", KEY).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("invalid challenge");
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Identity & { purpose: ChallengePurpose; exp: number };
  if (parsed.kind !== kind || parsed.exp < Date.now() || (purpose && parsed.purpose !== purpose)) throw new Error("invalid challenge");
  return parsed;
}

export async function beginMfaEnrollment(identity: Identity, label: string) {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const [credential] = await db.transaction(async (tx) => {
    await tx.delete(mfaCredentials).where(ownerWhere(identity));
    return tx.insert(mfaCredentials).values({
      ...(identity.kind === "user" ? { userId: identity.id } : { adminUserId: identity.id }),
      encryptedSecret: encrypt(secret),
    }).returning();
  });
  const totp = makeTotp(secret, label);
  return { credential: credential!, secret, otpauthUri: totp.toString() };
}

function makeTotp(secret: string, label = "account") {
  return new OTPAuth.TOTP({ issuer: ISSUER, label, algorithm: "SHA1", digits: 6, period: TOTP_PERIOD, secret: OTPAuth.Secret.fromBase32(secret) });
}

function normalizeRecoveryCode(code: string) { return code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase(); }
function recoveryHash(code: string) { return createHmac("sha256", KEY).update(normalizeRecoveryCode(code)).digest("hex"); }

export async function verifyMfaCode(credential: NonNullable<Awaited<ReturnType<typeof getMfaCredential>>>, code: string, consumeRecovery = true): Promise<boolean> {
  const normalized = code.replace(/\s/g, "");
  if (/^\d{6}$/.test(normalized)) {
    const delta = makeTotp(decrypt(credential.encryptedSecret)).validate({ token: normalized, window: 1 });
    if (delta !== null) {
      // Absolute timestep the accepted code belongs to. validate() returns the period offset within the
      // ±1 skew window, so the true step is the current counter plus that offset.
      const step = Math.floor(Date.now() / 1000 / TOTP_PERIOD) + delta;
      // Reject a code at or below the last accepted step. Without this a captured/observed code could be
      // replayed for the ~90s it stays inside the skew window.
      if (credential.lastTotpStep !== null && step <= credential.lastTotpStep) return false;
      await db.update(mfaCredentials).set({ lastTotpStep: step, updatedAt: new Date() }).where(eq(mfaCredentials.id, credential.id));
      return true;
    }
  }
  const hash = recoveryHash(code);
  const [row] = await db.select().from(mfaRecoveryCodes).where(and(eq(mfaRecoveryCodes.credentialId, credential.id), eq(mfaRecoveryCodes.codeHash, hash), isNull(mfaRecoveryCodes.consumedAt))).limit(1);
  if (!row) return false;
  if (!consumeRecovery) return true;
  const consumed = await db.update(mfaRecoveryCodes).set({ consumedAt: new Date() }).where(and(eq(mfaRecoveryCodes.id, row.id), isNull(mfaRecoveryCodes.consumedAt))).returning({ id: mfaRecoveryCodes.id });
  return consumed.length === 1;
}

// Login-time verification with a durable per-credential lockout. Used by the tenant and admin
// /mfa/verify endpoints (not the password-gated management actions). A locked credential returns
// false just like a wrong code, so the caller's generic error never reveals the lock state.
export async function verifyMfaLoginCode(credential: NonNullable<Awaited<ReturnType<typeof getMfaCredential>>>, code: string): Promise<boolean> {
  if (credential.lockedUntil && credential.lockedUntil.getTime() > Date.now()) return false;
  if (await verifyMfaCode(credential, code)) {
    if (credential.failedVerifyAttempts !== 0 || credential.lockedUntil) {
      await db.update(mfaCredentials).set({ failedVerifyAttempts: 0, lockedUntil: null, updatedAt: new Date() }).where(eq(mfaCredentials.id, credential.id));
    }
    return true;
  }
  // Increment in SQL so concurrent failures cannot overwrite one another and slip past the cap.
  const [row] = await db.update(mfaCredentials)
    .set({ failedVerifyAttempts: sql`${mfaCredentials.failedVerifyAttempts} + 1`, updatedAt: new Date() })
    .where(eq(mfaCredentials.id, credential.id))
    .returning({ attempts: mfaCredentials.failedVerifyAttempts });
  if (row && row.attempts >= MAX_MFA_ATTEMPTS) {
    await db.update(mfaCredentials).set({ lockedUntil: new Date(Date.now() + MFA_LOCK_MS) }).where(eq(mfaCredentials.id, credential.id));
  }
  return false;
}

export async function enableMfa(credentialId: string): Promise<string[]> {
  const codes = Array.from({ length: 10 }, () => randomBytes(8).toString("hex").toUpperCase().match(/.{1,4}/g)!.join("-"));
  await db.transaction(async (tx) => {
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.credentialId, credentialId));
    await tx.insert(mfaRecoveryCodes).values(codes.map((code) => ({ credentialId, codeHash: recoveryHash(code) })));
    await tx.update(mfaCredentials).set({ enabledAt: new Date(), updatedAt: new Date() }).where(eq(mfaCredentials.id, credentialId));
  });
  return codes;
}

export async function regenerateRecoveryCodes(credentialId: string) { return enableMfa(credentialId); }
export async function resetMfa(identity: Identity, executor: Pick<typeof db, "delete"> = db) {
  await executor.delete(mfaCredentials).where(ownerWhere(identity));
}
