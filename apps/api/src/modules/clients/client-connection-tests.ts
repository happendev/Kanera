import type { dto } from "@kanera/shared";
import type { Locale } from "@kanera/shared/locales";
import type { FastifyBaseLogger } from "fastify";
import type { AuthClaims } from "../../auth/plugin.js";
import { env } from "../../env.js";
import { badRequest } from "../../lib/errors.js";
import { mergeSmtpPassword, smtpConfigFromEnv, testSmtpConfig } from "../../lib/smtp.js";
import { createStorageForConfig, getConfiguredS3StorageConfig } from "../../lib/storage/index.js";
import { storageProbeKey } from "../../lib/storage/keys.js";
import { loadClient } from "./client-queries.js";
import { resolveS3StorageConfig } from "./route-support.js";

/** `POST /clients/me/smtp/test`: sends a test email through the env or the proposed SMTP config. */
export async function testClientSmtp({ auth, body, locale }: { auth: AuthClaims; body: dto.TestClientSmtpBody; locale: Locale }) {
  if (env.KANERA_DEPLOYMENT_MODE === "hosted") {
    throw badRequest("smtp is configured by the hosted deployment");
  }
  const envConfig = smtpConfigFromEnv();
  if (envConfig) {
    await testSmtpConfig(envConfig, body.to, locale);
    return { ok: true };
  }
  if (!body.smtpConfig) throw badRequest("smtpConfig required");
  const current = await loadClient(auth.cid);
  const config = mergeSmtpPassword(body.smtpConfig, current.smtpConfig ?? smtpConfigFromEnv());
  await testSmtpConfig(config, body.to, locale);
  return { ok: true };
}

/** `POST /clients/me/storage/test`: writes and deletes a probe object with the env or proposed storage config. */
export async function testClientStorage({ auth, body, log }: { auth: AuthClaims; body: dto.TestClientStorageBody; log: FastifyBaseLogger }) {
  if (env.KANERA_DEPLOYMENT_MODE === "hosted") {
    throw badRequest("storage is configured by the hosted deployment");
  }

  const configuredS3 = getConfiguredS3StorageConfig();
  let storageConfig = configuredS3;
  if (!storageConfig) {
    if (!body.storageConfig) throw badRequest("storageConfig required");
    const current = await loadClient(auth.cid);
    storageConfig = resolveS3StorageConfig(body.storageConfig, current.storageConfig);
  }
  const storage = createStorageForConfig(auth.cid, storageConfig);
  const key = storageProbeKey();
  const probe = Buffer.alloc(1024, "k");

  await storage.put(key, probe, "text/plain");

  try {
    await storage.delete(key);
  } catch (err) {
    log.warn({ err, key }, "failed to delete storage test object");
    throw err;
  }

  return { ok: true };
}
