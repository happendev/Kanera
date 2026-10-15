CREATE TABLE "card_attachment_reaction" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"attachment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reaction_type" text DEFAULT 'thumbs_up' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_attachment_reactions_type_ck" CHECK ("card_attachment_reaction"."reaction_type" in ('thumbs_up'))
);
--> statement-breakpoint
ALTER TABLE "email_queue" DROP CONSTRAINT "email_queue_type_ck";--> statement-breakpoint
ALTER TABLE "notification" DROP CONSTRAINT "notifications_reason_ck";--> statement-breakpoint
ALTER TABLE "push_queue" DROP CONSTRAINT "push_queue_reason_ck";--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "reaction_added_email" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "reaction_added_push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "reaction_added_ntfy" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "reaction_added_gotify" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "reaction_added_webhook" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notification_workspace_rule" ADD COLUMN "reaction_added_email" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notification_workspace_rule" ADD COLUMN "reaction_added_push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notification_workspace_rule" ADD COLUMN "reaction_added_ntfy" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notification_workspace_rule" ADD COLUMN "reaction_added_gotify" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notification_workspace_rule" ADD COLUMN "reaction_added_webhook" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "card_attachment_reaction" ADD CONSTRAINT "card_attachment_reaction_attachment_id_card_attachment_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."card_attachment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_attachment_reaction" ADD CONSTRAINT "card_attachment_reaction_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "card_attachment_reactions_attachment_user_type_uniq" ON "card_attachment_reaction" USING btree ("attachment_id","user_id","reaction_type");--> statement-breakpoint
CREATE INDEX "card_attachment_reactions_attachment_idx" ON "card_attachment_reaction" USING btree ("attachment_id");--> statement-breakpoint
ALTER TABLE "email_queue" ADD CONSTRAINT "email_queue_type_ck" CHECK ("email_queue"."type" in ('admin_invite', 'welcome', 'password_reset', 'email_verification', 'daily_digest', 'weekly_admin_recap', 'card_assigned', 'card_comment_added', 'comment_mentioned', 'reaction_added', 'card_due_date_changed', 'card_overdue', 'checklist_item_overdue', 'card_reminder', 'invite_accepted', 'board_invite', 'board_access_granted', 'pro_trial_started', 'pro_trial_warning', 'downgraded_to_free', 'upgraded_to_pro', 'welcome_to_pro', 'billing_changed', 'billing_renewed', 'billing_payment_failed', 'billing_payment_recovered', 'seat_billed', 'seat_capacity_reduced', 'pro_cancellation_scheduled', 'pro_cancellation_reversed', 'pro_cancelled', 'import_completed', 'storage_warning', 'lifecycle_no_board', 'lifecycle_invite_team', 'lifecycle_early_success', 'lifecycle_inactive', 'lifecycle_active_checkin'));--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notifications_reason_ck" CHECK ("notification"."reason" in ('assigned', 'watching', 'mentioned', 'overdue', 'checklist_item_overdue', 'board_member_left', 'reminder', 'reacted'));--> statement-breakpoint
ALTER TABLE "push_queue" ADD CONSTRAINT "push_queue_reason_ck" CHECK ("push_queue"."reason" in ('test', 'assigned', 'mentioned', 'comment', 'dueDateChanged', 'overdue', 'watching', 'reminder', 'reacted'));