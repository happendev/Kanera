import type { PublicClientResponse } from "@kanera/shared/dto";
import type { clients, StorageConfig } from "@kanera/shared/schema";
import { env } from "../../env.js";
import { badRequest } from "../../lib/errors.js";
import { withSignedMedia } from "../../lib/media-keys.js";
import { redactSmtpConfig, smtpConfigFromEnv } from "../../lib/smtp.js";
import { getConfiguredS3StorageConfig } from "../../lib/storage/index.js";
import { getFreePlanLimits } from "../../lib/tier-limits.js";

export type ClientRow = typeof clients.$inferSelect;
type S3StorageConfig = Extract<StorageConfig, { kind: "s3" }>;

const REDACTED = "***";

function redact(config: StorageConfig | null): StorageConfig {
  if (!config || config.kind === "local") return { kind: "local" };
  return { ...config, accessKeyId: REDACTED, secretAccessKey: REDACTED };
}

export function toPublicClient(row: ClientRow): PublicClientResponse {
  if (env.KANERA_DEPLOYMENT_MODE === "hosted") {
    return {
      id: row.id,
      name: row.name,
      logoUrl: withSignedMedia(row.id, { logoUrl: row.logoUrl }).logoUrl,
      deploymentMode: "hosted",
      pushEnabled: true,
      requireMfa: row.requireMfa,
      inProgressEnabled: row.inProgressEnabled,
      dependenciesEnabled: row.dependenciesEnabled,
      timelineEnabled: row.timelineEnabled,
      mcpPolicy: row.mcpPolicy,
      defaultCompletedCardsActiveDays: row.defaultCompletedCardsActiveDays,
      defaultInactiveCardsDays: row.defaultInactiveCardsDays,
      // Hosted deployments own SMTP/storage at the environment layer, so do not expose
      // provider details or redacted secrets to tenant admins.
      storageConfig: { kind: "local" },
      storageConfigSource: "env",
      smtpConfig: null,
      smtpConfigSource: null,
      proPricing: {
        monthlyCents: env.HOSTED_PRO_PRICE_MONTHLY_CENTS,
        annualCents: env.HOSTED_PRO_PRICE_ANNUAL_CENTS,
      },
      freePlanLimits: getFreePlanLimits(),
    };
  }

  const envSmtp = smtpConfigFromEnv();
  const smtpConfig = envSmtp ?? row.smtpConfig;
  const envStorageConfig = getConfiguredS3StorageConfig();
  const storageConfig = envStorageConfig ?? row.storageConfig;
  return {
    id: row.id,
    name: row.name,
    logoUrl: withSignedMedia(row.id, { logoUrl: row.logoUrl }).logoUrl,
    deploymentMode: "self_hosted",
    pushEnabled: row.pushEnabled,
    requireMfa: row.requireMfa,
    inProgressEnabled: row.inProgressEnabled,
    dependenciesEnabled: row.dependenciesEnabled,
    timelineEnabled: row.timelineEnabled,
    // Not enforced self-hosted (lib/mcp-policy.ts), so report the effective value.
    mcpPolicy: "write",
    defaultCompletedCardsActiveDays: row.defaultCompletedCardsActiveDays,
    defaultInactiveCardsDays: row.defaultInactiveCardsDays,
    storageConfig: redact(storageConfig),
    storageConfigSource: envStorageConfig ? "env" : "client",
    smtpConfig: redactSmtpConfig(smtpConfig),
    smtpConfigSource: envSmtp ? "env" : row.smtpConfig ? "client" : null,
    proPricing: null,
    freePlanLimits: null,
  };
}

export function resolveS3StorageConfig(incoming: S3StorageConfig, current: StorageConfig | null | undefined): S3StorageConfig {
  const existing = current?.kind === "s3" ? current : null;
  const accessKeyId = incoming.accessKeyId === REDACTED && existing ? existing.accessKeyId : incoming.accessKeyId;
  const secretAccessKey = incoming.secretAccessKey === REDACTED && existing ? existing.secretAccessKey : incoming.secretAccessKey;

  if (accessKeyId === REDACTED) {
    throw badRequest("accessKeyId required");
  }

  if (secretAccessKey === REDACTED) {
    throw badRequest("secretAccessKey required");
  }

  return {
    ...incoming,
    accessKeyId,
    secretAccessKey,
  };
}
