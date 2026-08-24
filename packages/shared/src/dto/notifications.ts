import { z } from "zod";
import { ianaTimeZone } from "./_time-zone.js";
import type { ActivityEvent } from "../schema/activity-event.js";
import type { Notification, NotificationReason } from "../schema/notification.js";
import type { CardDueDateSlot } from "../lib/due-date-slots.js";

export const NOTIFICATION_SETTING_TYPES = [
  "cardAssigned",
  "cardCommentAdded",
  "commentMentioned",
  "cardDueDateChanged",
  "cardOverdue",
] as const;
export type NotificationSettingType = (typeof NOTIFICATION_SETTING_TYPES)[number];

export const notificationChannelSettings = z.object({
  email: z.boolean(),
  push: z.boolean(),
  ntfy: z.boolean(),
  gotify: z.boolean(),
  webhook: z.boolean(),
});

export const notificationSettingsMatrix = z.object({
  cardAssigned: notificationChannelSettings,
  cardCommentAdded: notificationChannelSettings,
  commentMentioned: notificationChannelSettings,
  cardDueDateChanged: notificationChannelSettings,
  cardOverdue: notificationChannelSettings,
});

export const notificationWorkspaceRule = z.object({
  workspaceId: z.uuid(),
  paused: z.boolean(),
  types: notificationSettingsMatrix,
});
export type NotificationWorkspaceRule = z.infer<typeof notificationWorkspaceRule>;

export const putNotificationWorkspaceRuleBody = notificationWorkspaceRule.omit({ workspaceId: true });
export type PutNotificationWorkspaceRuleBody = z.infer<typeof putNotificationWorkspaceRuleBody>;

export const updateNotificationSettingsBody = z.object({
  emailEnabled: z.boolean().optional(),
  pushEnabled: z.boolean().optional(),
  watchedActivityOutbound: z.boolean().optional(),
  personalChannels: z.object({
    ntfy: z.object({
      enabled: z.boolean().optional(),
      serverUrl: z.string().trim().max(2048).nullable().optional(),
      topic: z.string().trim().max(256).nullable().optional(),
      token: z.string().max(4096).nullable().optional(),
    }).optional(),
    gotify: z.object({
      enabled: z.boolean().optional(),
      serverUrl: z.string().trim().max(2048).nullable().optional(),
      token: z.string().max(4096).nullable().optional(),
    }).optional(),
    webhook: z.object({
      enabled: z.boolean().optional(),
      url: z.string().trim().max(2048).nullable().optional(),
    }).optional(),
  }).optional(),
  types: z.object({
    cardAssigned: notificationChannelSettings.partial().optional(),
    cardCommentAdded: notificationChannelSettings.partial().optional(),
    commentMentioned: notificationChannelSettings.partial().optional(),
    cardDueDateChanged: notificationChannelSettings.partial().optional(),
    cardOverdue: notificationChannelSettings.partial().optional(),
  }).optional(),
});
export type UpdateNotificationSettingsBody = z.infer<typeof updateNotificationSettingsBody>;

export const notificationSettingsResponse = z.object({
  userId: z.uuid(),
  emailEnabled: z.boolean(),
  pushEnabled: z.boolean(),
  watchedActivityOutbound: z.boolean(),
  types: notificationSettingsMatrix,
  push: z.object({
    status: z.enum(["enabled", "org-disabled", "system-disabled"]),
    registrationEnabled: z.boolean(),
    enabled: z.boolean(),
    publicKey: z.string().min(1).nullable(),
  }),
  personalChannels: z.object({
    destinationPolicy: z.enum(["public-https", "private-network-allowed"]),
    ntfy: z.object({
      enabled: z.boolean(),
      configured: z.boolean(),
      serverUrl: z.string().nullable(),
      topic: z.string().nullable(),
      tokenConfigured: z.boolean(),
    }),
    gotify: z.object({
      enabled: z.boolean(),
      configured: z.boolean(),
      serverUrl: z.string().nullable(),
      tokenConfigured: z.boolean(),
    }),
    webhook: z.object({
      enabled: z.boolean(),
      configured: z.boolean(),
      url: z.string().nullable(),
      secretConfigured: z.boolean(),
    }),
  }),
  generatedWebhookSecret: z.string().optional(),
  workspaceRules: z.array(notificationWorkspaceRule),
});

export interface NotificationSettingsResponse {
  emailEnabled: boolean;
  pushEnabled: boolean;
  watchedActivityOutbound: boolean;
  types: z.infer<typeof notificationSettingsMatrix>;
  push: {
    status: "enabled" | "org-disabled" | "system-disabled";
    registrationEnabled: boolean;
    enabled: boolean;
    publicKey: string | null;
  };
  personalChannels: {
    destinationPolicy: "public-https" | "private-network-allowed";
    ntfy: { enabled: boolean; configured: boolean; serverUrl: string | null; topic: string | null; tokenConfigured: boolean };
    gotify: { enabled: boolean; configured: boolean; serverUrl: string | null; tokenConfigured: boolean };
    webhook: { enabled: boolean; configured: boolean; url: string | null; secretConfigured: boolean };
  };
  generatedWebhookSecret?: string;
  workspaceRules: NotificationWorkspaceRule[];
}

export const personalNotificationChannel = z.enum(["ntfy", "gotify", "webhook"]);
export type PersonalNotificationChannel = z.infer<typeof personalNotificationChannel>;

export const personalNotificationTestResponse = z.object({
  channel: personalNotificationChannel,
  delivered: z.boolean(),
  error: z.string().nullable(),
});
export type PersonalNotificationTestResponse = z.infer<typeof personalNotificationTestResponse>;

export const listNotificationsQuery = z.object({
  // Opaque keyset cursor of the form `<createdAt ISO>|<notification id>`. Kept
  // as a free string (not a bare datetime) so pagination can tie-break on id;
  // see encode/decodeCursor in the notifications routes.
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  includeRead: z.coerce.boolean().default(false),
  boardId: z.uuid().optional(),
  actorId: z.uuid().optional(),
  q: z.string().trim().min(1).max(200).optional(),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuery>;

export const notificationGroupBy = z.enum(["day", "board", "user", "organisation"]);
export type NotificationGroupBy = z.infer<typeof notificationGroupBy>;

export const notificationGroupCountsQuery = listNotificationsQuery
  .omit({ cursor: true, limit: true })
  .extend({
    groupBy: notificationGroupBy.default("day"),
    timeZone: ianaTimeZone,
  });
export type NotificationGroupCountsQuery = z.infer<typeof notificationGroupCountsQuery>;

export interface NotificationGroupCount {
  key: string;
  count: number;
}

export interface NotificationGroupCountsResponse {
  groups: NotificationGroupCount[];
}

export const markNotificationsReadBody = z.object({
  notificationIds: z.array(z.uuid()).min(1),
});
export type MarkNotificationsReadBody = z.infer<typeof markNotificationsReadBody>;

export interface NotificationCardThumbnail {
  id: string;
  url: string;
  thumbnailUrl: string | null;
  mimeType: string;
  fileName: string;
}

export type NotificationRow = Notification & {
  /** The server matched this row against the active search, including historical card-key aliases. */
  searchMatched?: boolean;
  reason: NotificationReason;
  activity: ActivityEvent | null;
  actorName: string | null;
  actorAvatarUrl: string | null;
  cardTitle: string | null;
  cardKey: string | null;
  organisationKey: string | null;
  cardCompletedAt: Date | null;
  cardArchivedAt: Date | null;
  cardDueDateLocalDate: string | null;
  cardDueDateSlot: CardDueDateSlot | null;
  cardDueDateTimezone: string | null;
  checklistItemText: string | null;
  checklistItemDueDateLocalDate: string | null;
  checklistItemDueDateSlot: CardDueDateSlot | null;
  checklistItemDueDateTimezone: string | null;
  viewerRole: "editor" | "observer" | null;
  listName: string | null;
  listColor: string | null;
  listIcon: string | null;
  boardName: string | null;
  boardIcon: string | null;
  boardIconColor: string | null;
  workspaceName: string | null;
  workspaceIcon: string | null;
  workspaceAccentColor: string | null;
  orgName: string;
  orgLogoUrl: string | null;
  attachment: NotificationCardThumbnail | null;
  commentBody: string | null;
};

export interface NotificationsPage {
  items: NotificationRow[];
  nextCursor: string | null;
  unreadCount: number;
}

export interface WatcherUser {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}
