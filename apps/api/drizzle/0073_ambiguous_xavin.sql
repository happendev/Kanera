CREATE TABLE "lifecycle_email_send" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lifecycle_email_send_kind_ck" CHECK ("lifecycle_email_send"."kind" in ('no_board', 'invite_team', 'early_success', 'inactive', 'active_checkin'))
);
--> statement-breakpoint
ALTER TABLE "email_queue" DROP CONSTRAINT "email_queue_type_ck";--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "lifecycle_email" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "lifecycle_email_send" ADD CONSTRAINT "lifecycle_email_send_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lifecycle_email_send_client_kind_key_uq" ON "lifecycle_email_send" USING btree ("client_id","kind","dedupe_key");--> statement-breakpoint
CREATE INDEX "lifecycle_email_send_kind_created_at_idx" ON "lifecycle_email_send" USING btree ("kind","created_at");--> statement-breakpoint
ALTER TABLE "email_queue" ADD CONSTRAINT "email_queue_type_ck" CHECK ("email_queue"."type" in ('admin_invite', 'welcome', 'password_reset', 'email_verification', 'daily_digest', 'weekly_admin_recap', 'card_assigned', 'card_comment_added', 'comment_mentioned', 'card_due_date_changed', 'card_overdue', 'checklist_item_overdue', 'invite_accepted', 'board_invite', 'board_access_granted', 'pro_trial_started', 'pro_trial_warning', 'downgraded_to_free', 'upgraded_to_pro', 'welcome_to_pro', 'billing_changed', 'billing_renewed', 'billing_payment_failed', 'billing_payment_recovered', 'seat_billed', 'seat_capacity_reduced', 'pro_cancellation_scheduled', 'pro_cancellation_reversed', 'pro_cancelled', 'import_completed', 'lifecycle_no_board', 'lifecycle_invite_team', 'lifecycle_early_success', 'lifecycle_inactive', 'lifecycle_active_checkin'));