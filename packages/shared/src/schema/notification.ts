import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { activityEvents } from "./activity-event.js";
import { boards } from "./board.js";
import { cards } from "./card.js";
import { cardChecklistItems } from "./card-checklist.js";
import { lists } from "./list.js";
import { users } from "./user.js";
import { workspaces } from "./workspace.js";

export const NOTIFICATION_REASONS = ["assigned", "watching", "mentioned", "overdue", "checklist_item_overdue"] as const;
export type NotificationReason = (typeof NOTIFICATION_REASONS)[number];
export const NOTIFICATION_REASON = {
  ASSIGNED: "assigned",
  WATCHING: "watching",
  MENTIONED: "mentioned",
  OVERDUE: "overdue",
  CHECKLIST_ITEM_OVERDUE: "checklist_item_overdue",
} as const satisfies Record<string, NotificationReason>;

export const notifications = pgTable(
  "notification",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    activityId: uuid("activity_id")
      .references(() => activityEvents.id, { onDelete: "cascade" }),
    cardId: uuid("card_id").references(() => cards.id, { onDelete: "cascade" }),
    checklistItemId: uuid("checklist_item_id").references(() => cardChecklistItems.id, { onDelete: "cascade" }),
    listId: uuid("list_id").references(() => lists.id, { onDelete: "set null" }),
    boardId: uuid("board_id").references(() => boards.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    reason: text("reason").notNull().$type<NotificationReason>(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notifications_user_id_created_at_idx").on(t.userId, t.createdAt),
    index("notifications_user_id_unread_idx")
      .on(t.userId, t.createdAt)
      .where(sql`${t.readAt} is null`),
    uniqueIndex("notifications_user_activity_uniq").on(t.userId, t.activityId),
    uniqueIndex("notifications_overdue_user_card_uniq")
      .on(t.userId, t.cardId)
      .where(sql`${t.reason} = 'overdue' and ${t.cardId} is not null`),
    uniqueIndex("notifications_checklist_item_overdue_uniq")
      .on(t.userId, t.checklistItemId)
      .where(sql`${t.reason} = 'checklist_item_overdue' and ${t.checklistItemId} is not null`),
  ],
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
