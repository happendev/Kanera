import { z } from "zod";
import type { ActivityEvent } from "../schema/activity-event.js";
import type { Notification, NotificationReason } from "../schema/notification.js";

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
});

export const notificationSettingsMatrix = z.object({
  cardAssigned: notificationChannelSettings,
  cardCommentAdded: notificationChannelSettings,
  commentMentioned: notificationChannelSettings,
  cardDueDateChanged: notificationChannelSettings,
  cardOverdue: notificationChannelSettings,
});

export const updateNotificationSettingsBody = z.object({
  emailEnabled: z.boolean().optional(),
  pushEnabled: z.boolean().optional(),
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
  types: notificationSettingsMatrix,
  push: z.object({
    status: z.enum(["enabled", "org-disabled", "system-disabled"]),
    enabled: z.boolean(),
    publicKey: z.string().min(1).nullable(),
  }),
});

export interface NotificationSettingsResponse {
  emailEnabled: boolean;
  pushEnabled: boolean;
  types: z.infer<typeof notificationSettingsMatrix>;
  push: {
    status: "enabled" | "org-disabled" | "system-disabled";
    enabled: boolean;
    publicKey: string | null;
  };
}

export const listNotificationsQuery = z.object({
  // Opaque keyset cursor of the form `<createdAt ISO>|<notification id>`. Kept
  // as a free string (not a bare datetime) so pagination can tie-break on id;
  // see encode/decodeCursor in the notifications routes.
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  includeRead: z.coerce.boolean().default(false),
  boardId: z.uuid().optional(),
  actorId: z.uuid().optional(),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuery>;

export const markNotificationsReadBody = z.object({
  notificationIds: z.array(z.uuid()).min(1),
});
export type MarkNotificationsReadBody = z.infer<typeof markNotificationsReadBody>;

export interface NotificationCardThumbnail {
  url: string;
  thumbnailUrl: string | null;
  mimeType: string;
  fileName: string;
}

export type NotificationRow = Notification & {
  reason: NotificationReason;
  activity: ActivityEvent | null;
  actorName: string | null;
  actorAvatarUrl: string | null;
  cardTitle: string | null;
  cardCompletedAt: Date | null;
  cardArchivedAt: Date | null;
  cardDueDateLocalDate: string | null;
  cardDueDateSlot: "anyTime" | "morning" | "afternoon" | "endOfWorkDay" | null;
  cardDueDateTimezone: string | null;
  checklistItemText: string | null;
  checklistItemDueDateLocalDate: string | null;
  checklistItemDueDateSlot: "anyTime" | "morning" | "afternoon" | "endOfWorkDay" | null;
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
