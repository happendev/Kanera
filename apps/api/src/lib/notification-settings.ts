import { clients, notificationSettings, type NotificationSettings } from "@kanera/shared/schema";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type NotificationPreferenceType =
  | "cardAssigned"
  | "cardCommentAdded"
  | "commentMentioned"
  | "cardDueDateChanged"
  | "cardOverdue";

export interface EffectiveNotificationSettings {
  userId: string;
  emailEnabled: boolean;
  pushEnabled: boolean;
  types: Record<NotificationPreferenceType, { email: boolean; push: boolean }>;
}

export function defaultNotificationSettings(userId: string): EffectiveNotificationSettings {
  return {
    userId,
    emailEnabled: true,
    pushEnabled: false,
    types: {
      cardAssigned: { email: true, push: true },
      cardCommentAdded: { email: true, push: true },
      commentMentioned: { email: true, push: true },
      cardDueDateChanged: { email: true, push: true },
      cardOverdue: { email: true, push: true },
    },
  };
}

export function toEffectiveNotificationSettings(row: NotificationSettings | null | undefined, userId: string): EffectiveNotificationSettings {
  if (!row) return defaultNotificationSettings(userId);
  return {
    userId,
    emailEnabled: row.emailEnabled,
    pushEnabled: row.pushEnabled,
    types: {
      cardAssigned: { email: row.cardAssignedEmail, push: row.cardAssignedPush },
      cardCommentAdded: { email: row.cardCommentAddedEmail, push: row.cardCommentAddedPush },
      commentMentioned: { email: row.commentMentionedEmail, push: row.commentMentionedPush },
      cardDueDateChanged: { email: row.cardDueDateChangedEmail, push: row.cardDueDateChangedPush },
      cardOverdue: { email: row.cardOverdueEmail, push: row.cardOverduePush },
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

export async function isClientPushEnabled(tx: Tx, clientId: string): Promise<boolean> {
  const [row] = await tx.select({ pushEnabled: clients.pushEnabled }).from(clients).where(eq(clients.id, clientId)).limit(1);
  return Boolean(row?.pushEnabled);
}

export function allowsNotificationEmail(settings: EffectiveNotificationSettings, type: NotificationPreferenceType): boolean {
  return settings.emailEnabled && settings.types[type].email;
}

export function allowsNotificationPush(settings: EffectiveNotificationSettings, type: NotificationPreferenceType): boolean {
  return settings.pushEnabled && settings.types[type].push;
}
