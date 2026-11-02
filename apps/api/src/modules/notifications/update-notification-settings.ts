import { dto } from "@kanera/shared";
import { notificationSettings } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { badRequest } from "../../lib/errors.js";
import { toEffectiveNotificationSettings } from "../../lib/notification-settings.js";
import { encryptSecret } from "../../lib/secrets.js";
import { assertNotificationDestinationAllowed } from "../../lib/ssrf.js";
import { newWebhookSecret } from "../../lib/webhook-signing.js";
import { assertPersonalNotificationChannelsAllowed } from "../../lib/tier-limits.js";
import { getWebPushPublicConfig } from "../../lib/web-push.js";
import { visibleWorkspaceRuleResponses } from "./notification-rules.js";

function normalizedOptional(value: string | null | undefined, fallback: string | null): string | null {
  if (value === undefined) return fallback;
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

async function validatePersonalDestination(url: string, baseUrl: boolean): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest("invalid notification destination url");
  }
  if (parsed.hash) throw badRequest("notification destination url must not contain a fragment");
  if (baseUrl && parsed.search) throw badRequest("notification server url must not contain a query string");
  await assertNotificationDestinationAllowed(url);
}

/** `PATCH /notifications/settings`: merges the partial body over the stored row and returns the full settings response. */
export async function updateNotificationSettings({ auth, body }: { auth: AuthClaims; body: dto.UpdateNotificationSettingsBody }) {
  if (body.personalChannels !== undefined) await assertPersonalNotificationChannelsAllowed(auth.cid);
  const [existing] = await db.select().from(notificationSettings).where(eq(notificationSettings.userId, auth.sub)).limit(1);
  const personal = body.personalChannels;
  const ntfyServerUrl = normalizedOptional(personal?.ntfy?.serverUrl, existing?.ntfyServerUrl ?? null);
  const ntfyTopic = normalizedOptional(personal?.ntfy?.topic, existing?.ntfyTopic ?? null);
  const encryptedNtfyToken = personal?.ntfy?.token === undefined
    ? existing?.encryptedNtfyToken ?? null
    : personal.ntfy.token?.trim()
      ? encryptSecret(personal.ntfy.token.trim())
      : null;
  const gotifyServerUrl = normalizedOptional(personal?.gotify?.serverUrl, existing?.gotifyServerUrl ?? null);
  const encryptedGotifyToken = personal?.gotify?.token === undefined
    ? existing?.encryptedGotifyToken ?? null
    : personal.gotify.token?.trim()
      ? encryptSecret(personal.gotify.token.trim())
      : null;
  const webhookUrl = normalizedOptional(personal?.webhook?.url, existing?.webhookUrl ?? null);
  let encryptedWebhookSecret = webhookUrl ? existing?.encryptedWebhookSecret ?? null : null;
  let generatedWebhookSecret: string | undefined;
  if (webhookUrl && !encryptedWebhookSecret) {
    generatedWebhookSecret = newWebhookSecret();
    encryptedWebhookSecret = encryptSecret(generatedWebhookSecret);
  }

  if (ntfyServerUrl) await validatePersonalDestination(ntfyServerUrl, true);
  if (gotifyServerUrl) await validatePersonalDestination(gotifyServerUrl, true);
  if (webhookUrl) await validatePersonalDestination(webhookUrl, false);

  const requestedNtfyEnabled = personal?.ntfy?.enabled ?? existing?.ntfyEnabled ?? false;
  const requestedGotifyEnabled = personal?.gotify?.enabled ?? existing?.gotifyEnabled ?? false;
  const requestedWebhookEnabled = personal?.webhook?.enabled ?? existing?.webhookEnabled ?? false;
  if (personal?.ntfy?.enabled === true && (!ntfyServerUrl || !ntfyTopic)) throw badRequest("ntfy requires a server URL and topic");
  if (personal?.gotify?.enabled === true && (!gotifyServerUrl || !encryptedGotifyToken)) throw badRequest("Gotify requires a server URL and app token");
  if (personal?.webhook?.enabled === true && (!webhookUrl || !encryptedWebhookSecret)) throw badRequest("webhook requires a URL and signing secret");

  const values = {
    ...(body.emailEnabled !== undefined ? { emailEnabled: body.emailEnabled } : {}),
    ...(body.pushEnabled !== undefined ? { pushEnabled: body.pushEnabled } : {}),
    ...(body.watchedActivityOutbound !== undefined ? { watchedActivityOutbound: body.watchedActivityOutbound } : {}),
    ...(body.lifecycleEmail !== undefined ? { lifecycleEmail: body.lifecycleEmail } : {}),
    ...(personal ? {
      ntfyEnabled: requestedNtfyEnabled && Boolean(ntfyServerUrl && ntfyTopic),
      ntfyServerUrl,
      ntfyTopic,
      encryptedNtfyToken,
      gotifyEnabled: requestedGotifyEnabled && Boolean(gotifyServerUrl && encryptedGotifyToken),
      gotifyServerUrl,
      encryptedGotifyToken,
      webhookEnabled: requestedWebhookEnabled && Boolean(webhookUrl && encryptedWebhookSecret),
      webhookUrl,
      encryptedWebhookSecret,
    } : {}),
    ...(body.types?.cardAssigned?.email !== undefined ? { cardAssignedEmail: body.types.cardAssigned.email } : {}),
    ...(body.types?.cardAssigned?.push !== undefined ? { cardAssignedPush: body.types.cardAssigned.push } : {}),
    ...(body.types?.cardAssigned?.ntfy !== undefined ? { cardAssignedNtfy: body.types.cardAssigned.ntfy } : {}),
    ...(body.types?.cardAssigned?.gotify !== undefined ? { cardAssignedGotify: body.types.cardAssigned.gotify } : {}),
    ...(body.types?.cardAssigned?.webhook !== undefined ? { cardAssignedWebhook: body.types.cardAssigned.webhook } : {}),
    ...(body.types?.cardCommentAdded?.email !== undefined ? { cardCommentAddedEmail: body.types.cardCommentAdded.email } : {}),
    ...(body.types?.cardCommentAdded?.push !== undefined ? { cardCommentAddedPush: body.types.cardCommentAdded.push } : {}),
    ...(body.types?.cardCommentAdded?.ntfy !== undefined ? { cardCommentAddedNtfy: body.types.cardCommentAdded.ntfy } : {}),
    ...(body.types?.cardCommentAdded?.gotify !== undefined ? { cardCommentAddedGotify: body.types.cardCommentAdded.gotify } : {}),
    ...(body.types?.cardCommentAdded?.webhook !== undefined ? { cardCommentAddedWebhook: body.types.cardCommentAdded.webhook } : {}),
    ...(body.types?.commentMentioned?.email !== undefined ? { commentMentionedEmail: body.types.commentMentioned.email } : {}),
    ...(body.types?.commentMentioned?.push !== undefined ? { commentMentionedPush: body.types.commentMentioned.push } : {}),
    ...(body.types?.commentMentioned?.ntfy !== undefined ? { commentMentionedNtfy: body.types.commentMentioned.ntfy } : {}),
    ...(body.types?.commentMentioned?.gotify !== undefined ? { commentMentionedGotify: body.types.commentMentioned.gotify } : {}),
    ...(body.types?.commentMentioned?.webhook !== undefined ? { commentMentionedWebhook: body.types.commentMentioned.webhook } : {}),
    ...(body.types?.cardDueDateChanged?.email !== undefined ? { cardDueDateChangedEmail: body.types.cardDueDateChanged.email } : {}),
    ...(body.types?.cardDueDateChanged?.push !== undefined ? { cardDueDateChangedPush: body.types.cardDueDateChanged.push } : {}),
    ...(body.types?.cardDueDateChanged?.ntfy !== undefined ? { cardDueDateChangedNtfy: body.types.cardDueDateChanged.ntfy } : {}),
    ...(body.types?.cardDueDateChanged?.gotify !== undefined ? { cardDueDateChangedGotify: body.types.cardDueDateChanged.gotify } : {}),
    ...(body.types?.cardDueDateChanged?.webhook !== undefined ? { cardDueDateChangedWebhook: body.types.cardDueDateChanged.webhook } : {}),
    ...(body.types?.cardOverdue?.email !== undefined ? { cardOverdueEmail: body.types.cardOverdue.email } : {}),
    ...(body.types?.cardOverdue?.push !== undefined ? { cardOverduePush: body.types.cardOverdue.push } : {}),
    ...(body.types?.cardOverdue?.ntfy !== undefined ? { cardOverdueNtfy: body.types.cardOverdue.ntfy } : {}),
    ...(body.types?.cardOverdue?.gotify !== undefined ? { cardOverdueGotify: body.types.cardOverdue.gotify } : {}),
    ...(body.types?.cardOverdue?.webhook !== undefined ? { cardOverdueWebhook: body.types.cardOverdue.webhook } : {}),
    ...(body.types?.cardReminder?.email !== undefined ? { cardReminderEmail: body.types.cardReminder.email } : {}),
    ...(body.types?.cardReminder?.push !== undefined ? { cardReminderPush: body.types.cardReminder.push } : {}),
    ...(body.types?.cardReminder?.ntfy !== undefined ? { cardReminderNtfy: body.types.cardReminder.ntfy } : {}),
    ...(body.types?.cardReminder?.gotify !== undefined ? { cardReminderGotify: body.types.cardReminder.gotify } : {}),
    ...(body.types?.cardReminder?.webhook !== undefined ? { cardReminderWebhook: body.types.cardReminder.webhook } : {}),
    ...(body.types?.reactionAdded?.email !== undefined ? { reactionAddedEmail: body.types.reactionAdded.email } : {}),
    ...(body.types?.reactionAdded?.push !== undefined ? { reactionAddedPush: body.types.reactionAdded.push } : {}),
    ...(body.types?.reactionAdded?.ntfy !== undefined ? { reactionAddedNtfy: body.types.reactionAdded.ntfy } : {}),
    ...(body.types?.reactionAdded?.gotify !== undefined ? { reactionAddedGotify: body.types.reactionAdded.gotify } : {}),
    ...(body.types?.reactionAdded?.webhook !== undefined ? { reactionAddedWebhook: body.types.reactionAdded.webhook } : {}),
    ...(body.types?.cardDependency?.email !== undefined ? { cardDependencyEmail: body.types.cardDependency.email } : {}),
    ...(body.types?.cardDependency?.push !== undefined ? { cardDependencyPush: body.types.cardDependency.push } : {}),
    ...(body.types?.cardDependency?.ntfy !== undefined ? { cardDependencyNtfy: body.types.cardDependency.ntfy } : {}),
    ...(body.types?.cardDependency?.gotify !== undefined ? { cardDependencyGotify: body.types.cardDependency.gotify } : {}),
    ...(body.types?.cardDependency?.webhook !== undefined ? { cardDependencyWebhook: body.types.cardDependency.webhook } : {}),
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(notificationSettings)
    .values({ userId: auth.sub, ...values })
    .onConflictDoUpdate({
      target: notificationSettings.userId,
      set: values,
    })
    .returning();
  const [push, workspaceRules] = await Promise.all([
    getWebPushPublicConfig(auth.cid),
    visibleWorkspaceRuleResponses(auth),
  ]);
  return dto.notificationSettingsResponse.parse({ ...toEffectiveNotificationSettings(row, auth.sub), push, workspaceRules, ...(generatedWebhookSecret ? { generatedWebhookSecret } : {}) });
}
