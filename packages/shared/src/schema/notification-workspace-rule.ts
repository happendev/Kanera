import { sql } from "drizzle-orm";
import { boolean, index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./user.js";
import { workspaces } from "./workspace.js";

export const userNotificationWorkspaceRules = pgTable(
  "user_notification_workspace_rule",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    paused: boolean("paused").notNull().default(false),
    cardAssignedEmail: boolean("card_assigned_email").notNull().default(true),
    cardAssignedPush: boolean("card_assigned_push").notNull().default(true),
    cardAssignedNtfy: boolean("card_assigned_ntfy").notNull().default(true),
    cardAssignedGotify: boolean("card_assigned_gotify").notNull().default(true),
    cardAssignedWebhook: boolean("card_assigned_webhook").notNull().default(true),
    cardCommentAddedEmail: boolean("card_comment_added_email").notNull().default(true),
    cardCommentAddedPush: boolean("card_comment_added_push").notNull().default(true),
    cardCommentAddedNtfy: boolean("card_comment_added_ntfy").notNull().default(true),
    cardCommentAddedGotify: boolean("card_comment_added_gotify").notNull().default(true),
    cardCommentAddedWebhook: boolean("card_comment_added_webhook").notNull().default(true),
    commentMentionedEmail: boolean("comment_mentioned_email").notNull().default(true),
    commentMentionedPush: boolean("comment_mentioned_push").notNull().default(true),
    commentMentionedNtfy: boolean("comment_mentioned_ntfy").notNull().default(true),
    commentMentionedGotify: boolean("comment_mentioned_gotify").notNull().default(true),
    commentMentionedWebhook: boolean("comment_mentioned_webhook").notNull().default(true),
    cardDueDateChangedEmail: boolean("card_due_date_changed_email").notNull().default(true),
    cardDueDateChangedPush: boolean("card_due_date_changed_push").notNull().default(true),
    cardDueDateChangedNtfy: boolean("card_due_date_changed_ntfy").notNull().default(true),
    cardDueDateChangedGotify: boolean("card_due_date_changed_gotify").notNull().default(true),
    cardDueDateChangedWebhook: boolean("card_due_date_changed_webhook").notNull().default(true),
    cardOverdueEmail: boolean("card_overdue_email").notNull().default(true),
    cardOverduePush: boolean("card_overdue_push").notNull().default(true),
    cardOverdueNtfy: boolean("card_overdue_ntfy").notNull().default(true),
    cardOverdueGotify: boolean("card_overdue_gotify").notNull().default(true),
    cardOverdueWebhook: boolean("card_overdue_webhook").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("user_notification_workspace_rules_user_workspace_uniq").on(t.userId, t.workspaceId),
    index("user_notification_workspace_rules_workspace_id_idx").on(t.workspaceId),
  ],
);

export type UserNotificationWorkspaceRule = typeof userNotificationWorkspaceRules.$inferSelect;
