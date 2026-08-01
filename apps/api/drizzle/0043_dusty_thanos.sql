CREATE TABLE "user_notification_workspace_rule" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"card_assigned_email" boolean DEFAULT true NOT NULL,
	"card_assigned_push" boolean DEFAULT true NOT NULL,
	"card_assigned_ntfy" boolean DEFAULT true NOT NULL,
	"card_assigned_gotify" boolean DEFAULT true NOT NULL,
	"card_assigned_webhook" boolean DEFAULT true NOT NULL,
	"card_comment_added_email" boolean DEFAULT true NOT NULL,
	"card_comment_added_push" boolean DEFAULT true NOT NULL,
	"card_comment_added_ntfy" boolean DEFAULT true NOT NULL,
	"card_comment_added_gotify" boolean DEFAULT true NOT NULL,
	"card_comment_added_webhook" boolean DEFAULT true NOT NULL,
	"comment_mentioned_email" boolean DEFAULT true NOT NULL,
	"comment_mentioned_push" boolean DEFAULT true NOT NULL,
	"comment_mentioned_ntfy" boolean DEFAULT true NOT NULL,
	"comment_mentioned_gotify" boolean DEFAULT true NOT NULL,
	"comment_mentioned_webhook" boolean DEFAULT true NOT NULL,
	"card_due_date_changed_email" boolean DEFAULT true NOT NULL,
	"card_due_date_changed_push" boolean DEFAULT true NOT NULL,
	"card_due_date_changed_ntfy" boolean DEFAULT true NOT NULL,
	"card_due_date_changed_gotify" boolean DEFAULT true NOT NULL,
	"card_due_date_changed_webhook" boolean DEFAULT true NOT NULL,
	"card_overdue_email" boolean DEFAULT true NOT NULL,
	"card_overdue_push" boolean DEFAULT true NOT NULL,
	"card_overdue_ntfy" boolean DEFAULT true NOT NULL,
	"card_overdue_gotify" boolean DEFAULT true NOT NULL,
	"card_overdue_webhook" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plan_action" DROP CONSTRAINT "plan_actions_kind_ck";--> statement-breakpoint
ALTER TABLE "push_queue" DROP CONSTRAINT "push_queue_status_ck";--> statement-breakpoint
DROP INDEX "webhook_deliveries_endpoint_outbox_event_uq";--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ALTER COLUMN "url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ALTER COLUMN "encrypted_secret" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "ntfy_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "ntfy_server_url" text;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "ntfy_topic" text;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "encrypted_ntfy_token" text;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "gotify_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "gotify_server_url" text;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "encrypted_gotify_token" text;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "webhook_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "webhook_url" text;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "encrypted_webhook_secret" text;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "card_assigned_ntfy" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "card_assigned_gotify" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "card_assigned_webhook" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "card_comment_added_ntfy" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "card_comment_added_gotify" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "card_comment_added_webhook" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "comment_mentioned_ntfy" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "comment_mentioned_gotify" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "comment_mentioned_webhook" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "card_due_date_changed_ntfy" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "card_due_date_changed_gotify" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "card_due_date_changed_webhook" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "card_overdue_ntfy" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "card_overdue_gotify" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "card_overdue_webhook" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "push_queue" ADD COLUMN "channel" text DEFAULT 'webPush' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD COLUMN "provider" text DEFAULT 'generic' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD COLUMN "encrypted_config" text;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD COLUMN "priority_field_id" uuid;--> statement-breakpoint
ALTER TABLE "user_notification_workspace_rule" ADD CONSTRAINT "user_notification_workspace_rule_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notification_workspace_rule" ADD CONSTRAINT "user_notification_workspace_rule_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_notification_workspace_rules_user_workspace_uniq" ON "user_notification_workspace_rule" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE INDEX "user_notification_workspace_rules_workspace_id_idx" ON "user_notification_workspace_rule" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoint_priority_field_id_custom_field_id_fk" FOREIGN KEY ("priority_field_id") REFERENCES "public"."custom_field"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_endpoint_outbox_event_uq" ON "webhook_delivery" USING btree ("endpoint_id","outbox_event_id","event_type") WHERE "webhook_delivery"."outbox_event_id" is not null;--> statement-breakpoint
ALTER TABLE "plan_action" ADD CONSTRAINT "plan_actions_kind_ck" CHECK ("plan_action"."kind" in ('automation_disabled', 'webhook_disabled', 'personal_notification_channels_disabled', 'api_key_revoked', 'board_archived', 'workspace_archived', 'user_suspended', 'guest_member_removed', 'guest_invitation_revoked', 'guest_seat_removed'));--> statement-breakpoint
ALTER TABLE "push_queue" ADD CONSTRAINT "push_queue_channel_ck" CHECK ("push_queue"."channel" in ('webPush', 'ntfy', 'gotify', 'webhook'));--> statement-breakpoint
ALTER TABLE "push_queue" ADD CONSTRAINT "push_queue_status_ck" CHECK ("push_queue"."status" in ('queued', 'success', 'error', 'immediate', 'cancelled'));--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoints_provider_ck" CHECK ("webhook_endpoint"."provider" in ('generic', 'slack', 'discord', 'telegram', 'zulip'));--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoints_config_ck" CHECK ((
        ("webhook_endpoint"."provider" = 'generic' and "webhook_endpoint"."url" is not null and "webhook_endpoint"."encrypted_secret" is not null and "webhook_endpoint"."encrypted_config" is null)
        or
        ("webhook_endpoint"."provider" <> 'generic' and "webhook_endpoint"."url" is null and "webhook_endpoint"."encrypted_secret" is null and "webhook_endpoint"."encrypted_config" is not null)
      ));