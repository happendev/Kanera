import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./user.js";

export const notificationSettings = pgTable("notification_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  emailEnabled: boolean("email_enabled").notNull().default(true),
  pushEnabled: boolean("push_enabled").notNull().default(false),
  // Kanera only sends outbound notifications for work you own: cards you are assigned and
  // comments that mention you. The in-app drawer is broader - it also covers board and card
  // watchers. This opt-in widens outbound delivery (push and the personal channels, never
  // email) to those watcher rows too. Default off: a watcher on a busy board would otherwise
  // start receiving one notification per card move the moment this ships.
  watchedActivityOutbound: boolean("watched_activity_outbound").notNull().default(false),
  ntfyEnabled: boolean("ntfy_enabled").notNull().default(false),
  ntfyServerUrl: text("ntfy_server_url"),
  ntfyTopic: text("ntfy_topic"),
  encryptedNtfyToken: text("encrypted_ntfy_token"),
  gotifyEnabled: boolean("gotify_enabled").notNull().default(false),
  gotifyServerUrl: text("gotify_server_url"),
  encryptedGotifyToken: text("encrypted_gotify_token"),
  webhookEnabled: boolean("webhook_enabled").notNull().default(false),
  webhookUrl: text("webhook_url"),
  encryptedWebhookSecret: text("encrypted_webhook_secret"),
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
});

export type NotificationSettings = typeof notificationSettings.$inferSelect;
