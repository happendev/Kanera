import type { dto } from "@kanera/shared";
import { clients, type SmtpConfig, type StorageConfig } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { recordActivity } from "../../lib/activity.js";
import { badRequest, forbidden } from "../../lib/errors.js";
import { withSignedMedia } from "../../lib/media-keys.js";
import { resetScheduleLatches } from "../../lib/schedule-events.js";
import { encryptSmtpConfig, encryptStorageConfig } from "../../lib/secrets.js";
import { mergeSmtpPassword, smtpConfigFromEnv } from "../../lib/smtp.js";
import { getConfiguredS3StorageConfig } from "../../lib/storage/index.js";
import { ensureSystemWebPushConfig } from "../../lib/web-push.js";
import { emitToClient } from "../../realtime/emit.js";
import { emitWorkspaceFeaturesChanged } from "../../lib/workspace-features.js";
import { loadClient } from "./client-queries.js";
import { resolveS3StorageConfig, type ClientRow } from "./route-support.js";

/**
 * `PATCH /clients/me`: validates the settings change against the deployment mode and the current
 * row, then persists it. `featuresChanged` drives the workspace feature fanout in `emitClientUpdated`.
 */
export async function updateClient({ auth, body }: { auth: AuthClaims; body: dto.UpdateClientBody }) {
  const current = await loadClient(auth.cid);

  if (body.mcpPolicy !== undefined) {
    if (env.KANERA_DEPLOYMENT_MODE !== "hosted") throw badRequest("MCP policy applies to hosted organisations only");
    // The policy restricts agent credentials, so only an interactive admin session may change it;
    // an agent must never be able to lift its own cap.
    if (auth.authKind !== "user") throw forbidden();
  }

  if (env.KANERA_DEPLOYMENT_MODE === "hosted" && body.pushEnabled === false) {
    throw badRequest("push messaging is managed by the hosted deployment");
  }

  let nextStorage: StorageConfig | null | undefined = undefined;
  if (body.storageConfig) {
    if (env.KANERA_DEPLOYMENT_MODE === "hosted") {
      throw badRequest("storage is configured by the hosted deployment");
    }
    if (getConfiguredS3StorageConfig()) {
      throw badRequest("storage is configured by environment variables");
    }
    if (body.storageConfig.kind === "local") {
      nextStorage = { kind: "local" };
    } else {
      nextStorage = resolveS3StorageConfig(body.storageConfig, current.storageConfig);
    }
  }

  let nextSmtp: SmtpConfig | null | undefined = undefined;
  if (body.smtpConfig !== undefined) {
    if (env.KANERA_DEPLOYMENT_MODE === "hosted") {
      throw badRequest("smtp is configured by the hosted deployment");
    }
    if (smtpConfigFromEnv()) {
      throw badRequest("smtp is configured by environment variables");
    }
    if (body.smtpConfig === null) {
      nextSmtp = null;
    } else {
      const existing = current.smtpConfig ?? smtpConfigFromEnv();
      nextSmtp = mergeSmtpPassword(body.smtpConfig, existing);
      if ((nextSmtp.username || existing?.username) && !nextSmtp.password) {
        throw badRequest("smtp password required");
      }
    }
  }

  if (body.pushEnabled === true && !current.pushEnabled) {
    await ensureSystemWebPushConfig();
  }

  const updates: Partial<typeof clients.$inferInsert> & { updatedAt: Date } = { updatedAt: new Date() };
  if (body.name !== undefined) updates.name = body.name;
  if (body.pushEnabled !== undefined) updates.pushEnabled = body.pushEnabled;
  if (body.requireMfa !== undefined) updates.requireMfa = body.requireMfa;
  if (body.inProgressEnabled !== undefined) updates.inProgressEnabled = body.inProgressEnabled;
  if (body.dependenciesEnabled !== undefined) updates.dependenciesEnabled = body.dependenciesEnabled;
  if (body.timelineEnabled !== undefined) updates.timelineEnabled = body.timelineEnabled;
  if (body.mcpPolicy !== undefined) updates.mcpPolicy = body.mcpPolicy;
  if (body.defaultCompletedCardsActiveDays !== undefined) updates.defaultCompletedCardsActiveDays = body.defaultCompletedCardsActiveDays;
  if (body.defaultInactiveCardsDays !== undefined) updates.defaultInactiveCardsDays = body.defaultInactiveCardsDays;
  if (nextStorage !== undefined) updates.storageConfig = encryptStorageConfig(nextStorage);
  if (nextSmtp !== undefined) updates.smtpConfig = encryptSmtpConfig(nextSmtp);

  // The optional planning features are master switches over every workspace in the organisation.
  const featureChanges = {
    ...(body.inProgressEnabled !== undefined && body.inProgressEnabled !== current.inProgressEnabled && { inProgressEnabled: body.inProgressEnabled }),
    ...(body.dependenciesEnabled !== undefined && body.dependenciesEnabled !== current.dependenciesEnabled && { dependenciesEnabled: body.dependenciesEnabled }),
    ...(body.timelineEnabled !== undefined && body.timelineEnabled !== current.timelineEnabled && { timelineEnabled: body.timelineEnabled }),
  };
  const featuresChanged = Object.keys(featureChanges).length > 0;
  const [updated] = await db.transaction(async (tx) => {
    const result = await tx.update(clients).set(updates).where(eq(clients.id, auth.cid)).returning();
    if (featureChanges.dependenciesEnabled !== undefined || featureChanges.timelineEnabled !== undefined) {
      await resetScheduleLatches(tx, { clientId: auth.cid });
    }
    if (featuresChanged) {
      await recordActivity(tx, {
        boardId: null, workspaceId: null, clientId: auth.cid, actorId: auth.sub,
        entityType: "client", entityId: auth.cid, action: "updated",
        payload: featureChanges,
      });
    }
    return result;
  });
  return { updated: updated!, featuresChanged };
}

export async function emitClientUpdated({ auth, result }: { auth: AuthClaims; result: { updated: ClientRow; featuresChanged: boolean } }) {
  const { updated, featuresChanged } = result;
  if (featuresChanged) await emitWorkspaceFeaturesChanged({ clientId: auth.cid });
  emitToClient(auth.cid, "client:updated", withSignedMedia(auth.cid, {
    clientId: updated.id, name: updated.name, logoUrl: updated.logoUrl,
    inProgressEnabled: updated.inProgressEnabled, dependenciesEnabled: updated.dependenciesEnabled, timelineEnabled: updated.timelineEnabled,
  }));
}
