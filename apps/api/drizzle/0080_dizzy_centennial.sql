CREATE TABLE "card_reminder" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"card_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"remind_at" timestamp with time zone NOT NULL,
	"fired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_queue" DROP CONSTRAINT "email_queue_type_ck";--> statement-breakpoint
ALTER TABLE "notification" DROP CONSTRAINT "notifications_reason_ck";--> statement-breakpoint
ALTER TABLE "push_queue" DROP CONSTRAINT "push_queue_reason_ck";--> statement-breakpoint
ALTER TABLE "mcp_event_subscription" DROP CONSTRAINT "mcp_subscription_scope_ck";--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "card_reminder_email" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "card_reminder_push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "card_reminder_ntfy" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "card_reminder_gotify" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "card_reminder_webhook" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notification_workspace_rule" ADD COLUMN "card_reminder_email" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notification_workspace_rule" ADD COLUMN "card_reminder_push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notification_workspace_rule" ADD COLUMN "card_reminder_ntfy" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notification_workspace_rule" ADD COLUMN "card_reminder_gotify" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notification_workspace_rule" ADD COLUMN "card_reminder_webhook" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "card_reminder" ADD CONSTRAINT "card_reminder_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_reminder" ADD CONSTRAINT "card_reminder_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "card_reminders_card_user_uniq" ON "card_reminder" USING btree ("card_id","user_id");--> statement-breakpoint
CREATE INDEX "card_reminders_user_id_idx" ON "card_reminder" USING btree ("user_id","remind_at");--> statement-breakpoint
CREATE INDEX "card_reminders_pending_idx" ON "card_reminder" USING btree ("remind_at") WHERE "card_reminder"."fired_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_delivery_reminder_uq" ON "mcp_event_delivery" USING btree ("subscription_id",("payload"->'data'->>'reminderId')) WHERE "mcp_event_delivery"."payload"->>'name' = 'reminder.due';--> statement-breakpoint
ALTER TABLE "email_queue" ADD CONSTRAINT "email_queue_type_ck" CHECK ("email_queue"."type" in ('admin_invite', 'welcome', 'password_reset', 'email_verification', 'daily_digest', 'weekly_admin_recap', 'card_assigned', 'card_comment_added', 'comment_mentioned', 'card_due_date_changed', 'card_overdue', 'checklist_item_overdue', 'card_reminder', 'invite_accepted', 'board_invite', 'board_access_granted', 'pro_trial_started', 'pro_trial_warning', 'downgraded_to_free', 'upgraded_to_pro', 'welcome_to_pro', 'billing_changed', 'billing_renewed', 'billing_payment_failed', 'billing_payment_recovered', 'seat_billed', 'seat_capacity_reduced', 'pro_cancellation_scheduled', 'pro_cancellation_reversed', 'pro_cancelled', 'import_completed', 'lifecycle_no_board', 'lifecycle_invite_team', 'lifecycle_early_success', 'lifecycle_inactive', 'lifecycle_active_checkin'));--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notifications_reason_ck" CHECK ("notification"."reason" in ('assigned', 'watching', 'mentioned', 'overdue', 'checklist_item_overdue', 'board_member_left', 'reminder'));--> statement-breakpoint
ALTER TABLE "push_queue" ADD CONSTRAINT "push_queue_reason_ck" CHECK ("push_queue"."reason" in ('test', 'assigned', 'mentioned', 'comment', 'dueDateChanged', 'overdue', 'watching', 'reminder'));--> statement-breakpoint
ALTER TABLE "mcp_event_subscription" ADD CONSTRAINT "mcp_subscription_scope_ck" CHECK (case when "mcp_event_subscription"."name" in ('priorities.changed', 'my_day.ready', 'reminder.due')
    then "mcp_event_subscription"."target_user_id" = "mcp_event_subscription"."user_id" and "mcp_event_subscription"."workspace_id" is null and "mcp_event_subscription"."board_id" is null
    else "mcp_event_subscription"."workspace_id" is not null and "mcp_event_subscription"."target_user_id" is null end);