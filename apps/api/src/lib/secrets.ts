import type { SmtpConfig, StorageConfig } from "@kanera/shared/schema";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../env.js";

const ENCRYPTED_SECRET_PREFIX = "encv1";
const SECRET_IV_BYTES = 12;
const SECRET_TAG_BYTES = 16;

const deriveKey = (secret: string) => createHash("sha256").update(secret, "utf8").digest();

// Stored integration secrets (SMTP/S3/webhook) are encrypted with a key derived from a
// dedicated SECRETS_ENCRYPTION_KEY so that compromising the token-signing JWT_SECRET does not
// also expose them. When the dedicated key is absent we fall back to JWT_SECRET (legacy
// behaviour) and warn, because that reuses one key for two purposes.
const usingDedicatedKey = !!env.SECRETS_ENCRYPTION_KEY && env.SECRETS_ENCRYPTION_KEY !== env.JWT_SECRET;
if (!usingDedicatedKey) {
  console.warn(
    "[secrets] SECRETS_ENCRYPTION_KEY is not set (or equals JWT_SECRET); falling back to JWT_SECRET " +
      "to encrypt stored secrets. Set a distinct SECRETS_ENCRYPTION_KEY (openssl rand -hex 32) in production.",
  );
}

// New values are always encrypted under the primary key. Decryption tries the primary key first
// and then the legacy JWT_SECRET-derived key, so secrets written before a dedicated key was
// configured can still be read (and are transparently re-encrypted under the primary key when
// their config is next saved).
const PRIMARY_KEY = deriveKey(env.SECRETS_ENCRYPTION_KEY ?? env.JWT_SECRET);
const DECRYPT_KEYS = usingDedicatedKey ? [PRIMARY_KEY, deriveKey(env.JWT_SECRET)] : [PRIMARY_KEY];

function parseEncryptedSecret(value: string): [string, string, string] | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== ENCRYPTED_SECRET_PREFIX) return null;
  return [parts[1]!, parts[2]!, parts[3]!];
}

export function isEncryptedSecret(value: string): boolean {
  return parseEncryptedSecret(value) !== null;
}

export function encryptSecret(value: string): string {
  if (isEncryptedSecret(value)) return value;

  const iv = randomBytes(SECRET_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", PRIMARY_KEY, iv, { authTagLength: SECRET_TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    ENCRYPTED_SECRET_PREFIX,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    authTag.toString("base64url"),
  ].join(".");
}

export function decryptSecret(value: string): string {
  const parts = parseEncryptedSecret(value);
  if (!parts) return value;

  const [iv, ciphertext, authTag] = parts;
  // Try each candidate key; GCM's auth tag verification throws on the wrong key, so a successful
  // decrypt means the right key was used. This lets us read secrets written under the legacy key.
  let lastError: unknown;
  for (const key of DECRYPT_KEYS) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"), {
        authTagLength: SECRET_TAG_BYTES,
      });
      decipher.setAuthTag(Buffer.from(authTag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("failed to decrypt secret");
}

export function encryptSmtpConfig(config: SmtpConfig | null | undefined): SmtpConfig | null | undefined {
  if (!config?.password) return config;
  return { ...config, password: encryptSecret(config.password) };
}

export function decryptSmtpConfig(config: SmtpConfig | null | undefined): SmtpConfig | null | undefined {
  if (!config?.password) return config;
  return { ...config, password: decryptSecret(config.password) };
}

export function smtpConfigNeedsEncryption(config: SmtpConfig | null | undefined): boolean {
  return !!config?.password && !isEncryptedSecret(config.password);
}

export function encryptStorageConfig(config: StorageConfig | null | undefined): StorageConfig | null | undefined {
  if (!config || config.kind === "local") return config;
  return { ...config, secretAccessKey: encryptSecret(config.secretAccessKey) };
}

export function decryptStorageConfig(config: StorageConfig | null | undefined): StorageConfig | null | undefined {
  if (!config || config.kind === "local") return config;
  return { ...config, secretAccessKey: decryptSecret(config.secretAccessKey) };
}

export function storageConfigNeedsEncryption(config: StorageConfig | null | undefined): boolean {
  return !!config && config.kind === "s3" && !isEncryptedSecret(config.secretAccessKey);
}