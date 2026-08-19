import {
  clients,
  notificationSettings,
  userNotificationWorkspaceRules,
  type NotificationSettings,
} from "@kanera/shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db.js";
import { notificationDestinationPolicy } from "./ssrf.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type NotificationPreferenceType =
  | "cardAssigned"
  | "cardCommentAdded"
  | "commentMentioned"
  | "cardDueDateChanged"
  | "cardOverdue";

export type PersonalNotificationChannel = "ntfy" | "gotify" | "webhook";

export interface NotificationTypeChannels {
  email: boolean;
  push: boolean;
  ntfy: boolean;
  gotify: boolean;
  webhook: boolean;
}

export interface EffectiveNotificationSettings {
  userId: string;
  emailEnabled: boolean;
  pushEnabled: boolean;
  watchedActivityOutbound: boolean;
  ntfyEnabled: boolean;
  gotifyEnabled: boolean;
  webhookEnabled: boolean;
  types: Record<NotificationPreferenceType, NotificationTypeChannels>;
  personalChannels: {
    destinationPolicy: "public-https" | "private-network-allowed";
    ntfy: { enabled: boolean; configured: boolean; serverUrl: string | null; topic: string | null; tokenConfigured: boolean };
    gotify: { enabled: boolean; configured: boolean; serverUrl: string | null; tokenConfigured: boolean };
    webhook: { enabled: boolean; configured: boolean; url: string | null; secretConfigured: boolean };
  };
}

export interface EffectiveNotificationWorkspaceRule {
  workspaceId: string;
  paused: boolean;
  types: Record<NotificationPreferenceType, NotificationTypeChannels>;
}

export interface NotificationWorkspaceRuleScope {
  rule: EffectiveNotificationWorkspaceRule | undefined;
}

const defaultTypeChannels = (): NotificationTypeChannels => ({
  email: true,
  push: true,
  ntfy: true,
  gotify: true,
  webhook: true,
});

export function defaultNotificationSettings(userId: string): EffectiveNotificationSettings {
  return {
    userId,
    emailEnabled: true,
    pushEnabled: false,
    watchedActivityOutbound: false,
    ntfyEnabled: false,
    gotifyEnabled: false,
    webhookEnabled: false,
    types: {
      cardAssigned: defaultTypeChannels(),
      cardCommentAdded: defaultTypeChannels(),
      commentMentioned: defaultTypeChannels(),
      cardDueDateChanged: defaultTypeChannels(),
      cardOverdue: defaultTypeChannels(),
    },
    personalChannels: {
      destinationPolicy: notificationDestinationPolicy(),
      ntfy: { enabled: false, configured: false, serverUrl: null, topic: null, tokenConfigured: false },
      gotify: { enabled: false, configured: false, serverUrl: null, tokenConfigured: false },
      webhook: { enabled: false, configured: false, url: null, secretConfigured: false },
    },
  };
}

export function toEffectiveNotificationSettings(row: NotificationSettings | null | undefined, userId: string): EffectiveNotificationSettings {
  if (!row) return defaultNotificationSettings(userId);
  return {
    userId,
    emailEnabled: row.emailEnabled,
    pushEnabled: row.pushEnabled,
    watchedActivityOutbound: row.watchedActivityOutbound,
    ntfyEnabled: row.ntfyEnabled,
    gotifyEnabled: row.gotifyEnabled,
    webhookEnabled: row.webhookEnabled,
    types: {
      cardAssigned: { email: row.cardAssignedEmail, push: row.cardAssignedPush, ntfy: row.cardAssignedNtfy, gotify: row.cardAssignedGotify, webhook: row.cardAssignedWebhook },
      cardCommentAdded: { email: row.cardCommentAddedEmail, push: row.cardCommentAddedPush, ntfy: row.cardCommentAddedNtfy, gotify: row.cardCommentAddedGotify, webhook: row.cardCommentAddedWebhook },
      commentMentioned: { email: row.commentMentionedEmail, push: row.commentMentionedPush, ntfy: row.commentMentionedNtfy, gotify: row.commentMentionedGotify, webhook: row.commentMentionedWebhook },
      cardDueDateChanged: { email: row.cardDueDateChangedEmail, push: row.cardDueDateChangedPush, ntfy: row.cardDueDateChangedNtfy, gotify: row.cardDueDateChangedGotify, webhook: row.cardDueDateChangedWebhook },
      cardOverdue: { email: row.cardOverdueEmail, push: row.cardOverduePush, ntfy: row.cardOverdueNtfy, gotify: row.cardOverdueGotify, webhook: row.cardOverdueWebhook },
    },
    personalChannels: {
      destinationPolicy: notificationDestinationPolicy(),
      ntfy: {
        enabled: row.ntfyEnabled,
        configured: Boolean(row.ntfyServerUrl && row.ntfyTopic),
        serverUrl: row.ntfyServerUrl,
        topic: row.ntfyTopic,
        tokenConfigured: Boolean(row.encryptedNtfyToken),
      },
      gotify: {
        enabled: row.gotifyEnabled,
        configured: Boolean(row.gotifyServerUrl && row.encryptedGotifyToken),
        serverUrl: row.gotifyServerUrl,
        tokenConfigured: Boolean(row.encryptedGotifyToken),
      },
      webhook: {
        enabled: row.webhookEnabled,
        configured: Boolean(row.webhookUrl && row.encryptedWebhookSecret),
        url: row.webhookUrl,
        secretConfigured: Boolean(row.encryptedWebhookSecret),
      },
    },
  };
}

export async function getNotificationSettings(tx: Tx, userId: string): Promise<EffectiveNotificationSettings> {
  const [row] = await tx.select().from(notificationSettings).where(eq(notificationSettings.userId, userId)).limit(1);
  return toEffectiveNotificationSettings(row, userId);
}

export async function getNotificationSettingsForUsers(tx: Tx, userIds: string[]): Promise<Map<string, EffectiveNotificationSettings>> {
  const unique = Array.from(new Set(userIds));
  const result = new Map(unique.map((userId) => [userId, defaultNotificationSettings(userId)]));
  if (unique.length === 0) return result;
  const rows = await tx.select().from(notificationSettings).where(inArray(notificationSettings.userId, unique));
  for (const row of rows) result.set(row.userId, toEffectiveNotificationSettings(row, row.userId));
  return result;
}

export async function getNotificationWorkspaceRulesForUsers(
  tx: Tx,
  userIds: string[],
  workspaceIds?: string[],
): Promise<Map<string, Map<string, EffectiveNotificationWorkspaceRule>>> {
  const uniqueUserIds = Array.from(new Set(userIds));
  const result = new Map(uniqueUserIds.map((userId) => [userId, new Map<string, EffectiveNotificationWorkspaceRule>()]));
  if (uniqueUserIds.length === 0) return result;
  const uniqueWorkspaceIds = workspaceIds ? Array.from(new Set(workspaceIds)) : undefined;
  if (uniqueWorkspaceIds?.length === 0) return result;

  const rows = await tx
    .select()
    .from(userNotificationWorkspaceRules)
    .where(and(
      inArray(userNotificationWorkspaceRules.userId, uniqueUserIds),
      ...(uniqueWorkspaceIds ? [inArray(userNotificationWorkspaceRules.workspaceId, uniqueWorkspaceIds)] : []),
    ));

  for (const row of rows) {
    const userRules = result.get(row.userId)!;
    userRules.set(row.workspaceId, {
      workspaceId: row.workspaceId,
      paused: row.paused,
      types: {
        cardAssigned: { email: row.cardAssignedEmail, push: row.cardAssignedPush, ntfy: row.cardAssignedNtfy, gotify: row.cardAssignedGotify, webhook: row.cardAssignedWebhook },
        cardCommentAdded: { email: row.cardCommentAddedEmail, push: row.cardCommentAddedPush, ntfy: row.cardCommentAddedNtfy, gotify: row.cardCommentAddedGotify, webhook: row.cardCommentAddedWebhook },
        commentMentioned: { email: row.commentMentionedEmail, push: row.commentMentionedPush, ntfy: row.commentMentionedNtfy, gotify: row.commentMentionedGotify, webhook: row.commentMentionedWebhook },
        cardDueDateChanged: { email: row.cardDueDateChangedEmail, push: row.cardDueDateChangedPush, ntfy: row.cardDueDateChangedNtfy, gotify: row.cardDueDateChangedGotify, webhook: row.cardDueDateChangedWebhook },
        cardOverdue: { email: row.cardOverdueEmail, push: row.cardOverduePush, ntfy: row.cardOverdueNtfy, gotify: row.cardOverdueGotify, webhook: row.cardOverdueWebhook },
      },
    });
  }
  return result;
}

export async function getNotificationWorkspaceRules(
  tx: Tx,
  userId: string,
  workspaceIds?: string[],
): Promise<Map<string, EffectiveNotificationWorkspaceRule>> {
  return (await getNotificationWorkspaceRulesForUsers(tx, [userId], workspaceIds)).get(userId)!;
}

export async function isClientPushEnabled(tx: Tx, clientId: string): Promise<boolean> {
  const [row] = await tx.select({ pushEnabled: clients.pushEnabled }).from(clients).where(eq(clients.id, clientId)).limit(1);
  return Boolean(row?.pushEnabled);
}

function workspaceRuleAllowsChannel(
  scope: NotificationWorkspaceRuleScope | undefined,
  channel: keyof NotificationTypeChannels,
  type: NotificationPreferenceType,
): boolean {
  if (!scope?.rule) return true;
  return !scope.rule.paused && scope.rule.types[type][channel];
}

export function allowsNotificationEmail(
  settings: EffectiveNotificationSettings,
  type: NotificationPreferenceType,
  scope?: NotificationWorkspaceRuleScope,
): boolean {
  return settings.emailEnabled && settings.types[type].email && workspaceRuleAllowsChannel(scope, "email", type);
}

export function allowsDailyDigestEmail(
  settings: EffectiveNotificationSettings,
  scope?: NotificationWorkspaceRuleScope,
): boolean {
  return settings.emailEnabled && workspaceRuleAllowsChannel(scope, "email", "cardOverdue");
}

export function allowsNotificationPush(
  settings: EffectiveNotificationSettings,
  type: NotificationPreferenceType,
  scope?: NotificationWorkspaceRuleScope,
): boolean {
  return settings.pushEnabled && settings.types[type].push && workspaceRuleAllowsChannel(scope, "push", type);
}

/**
 * Watched activity has no preference *type* - a watcher's "card moved" is none of the five event
 * categories the settings matrix models - so the per-type columns cannot apply. Two coarser signals
 * from a workspace rule still must:
 *
 *  - `paused` is a categorical "send me nothing outbound from this workspace", which is exactly what
 *    the rule editor's copy promises. Ignoring it would make a paused workspace start pushing the
 *    moment this feature ships, which is a regression rather than a new feature.
 *  - A channel with every type turned off is the rule editor's channel column-header checkbox in its
 *    unchecked state, which users read as "not this channel, not from here".
 *
 * Anything finer-grained would be unexplainable in the UI: there is no row in the matrix a user
 * could point at to explain why their watched-card push went missing.
 */
function workspaceRuleAllowsAnyTypeOnChannel(
  scope: NotificationWorkspaceRuleScope | undefined,
  channel: keyof NotificationTypeChannels,
): boolean {
  if (!scope?.rule) return true;
  if (scope.rule.paused) return false;
  return Object.values(scope.rule.types).some((type) => type[channel]);
}

export function allowsWatchedActivityPush(
  settings: EffectiveNotificationSettings,
  scope?: NotificationWorkspaceRuleScope,
): boolean {
  return settings.watchedActivityOutbound
    && settings.pushEnabled
    && workspaceRuleAllowsAnyTypeOnChannel(scope, "push");
}

export function allowsWatchedActivityPersonalChannel(
  settings: EffectiveNotificationSettings,
  channel: PersonalNotificationChannel,
  scope?: NotificationWorkspaceRuleScope,
): boolean {
  return settings.watchedActivityOutbound
    && settings[`${channel}Enabled`]
    && workspaceRuleAllowsAnyTypeOnChannel(scope, channel);
}

export function allowsPersonalNotificationChannel(
  settings: EffectiveNotificationSettings,
  type: NotificationPreferenceType,
  channel: PersonalNotificationChannel,
  scope?: NotificationWorkspaceRuleScope,
): boolean {
  return settings[`${channel}Enabled`] && settings.types[type][channel] && workspaceRuleAllowsChannel(scope, channel, type);
}
