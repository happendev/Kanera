import { boolean, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./user.js";

export const notificationSettings = pgTable("notification_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  emailEnabled: boolean("email_enabled").notNull().default(true),
  pushEnabled: boolean("push_enabled").notNull().default(false),
  cardAssignedEmail: boolean("card_assigned_email").notNull().default(true),
  cardAssignedPush: boolean("card_assigned_push").notNull().default(true),
  cardCommentAddedEmail: boolean("card_comment_added_email").notNull().default(true),
  cardCommentAddedPush: boolean("card_comment_added_push").notNull().default(true),
  commentMentionedEmail: boolean("comment_mentioned_email").notNull().default(true),
  commentMentionedPush: boolean("comment_mentioned_push").notNull().default(true),
  cardDueDateChangedEmail: boolean("card_due_date_changed_email").notNull().default(true),
  cardDueDateChangedPush: boolean("card_due_date_changed_push").notNull().default(true),
  cardOverdueEmail: boolean("card_overdue_email").notNull().default(true),
  cardOverduePush: boolean("card_overdue_push").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type NotificationSettings = typeof notificationSettings.$inferSelect;
export type NewNotificationSettings = typeof notificationSettings.$inferInsert;
