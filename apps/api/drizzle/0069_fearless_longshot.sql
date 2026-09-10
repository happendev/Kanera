CREATE TABLE "agent_run" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"board_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_grant_id" uuid,
	"agent_name" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"external_url" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runs_status_ck" CHECK ("agent_run"."status" in ('running', 'blocked', 'succeeded', 'failed', 'cancelled', 'stalled'))
);
--> statement-breakpoint
ALTER TABLE "activity_event" DROP CONSTRAINT "activity_events_actor_kind_ck";--> statement-breakpoint
ALTER TABLE "comment" DROP CONSTRAINT "comments_author_kind_ck";--> statement-breakpoint
ALTER TABLE "activity_event" ADD COLUMN "agent_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "activity_event" ADD COLUMN "agent_name" text;--> statement-breakpoint
ALTER TABLE "comment" ADD COLUMN "agent_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "comment" ADD COLUMN "agent_name" text;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_agent_grant_id_oauth_grant_id_fk" FOREIGN KEY ("agent_grant_id") REFERENCES "public"."oauth_grant"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_card_id_started_at_idx" ON "agent_run" USING btree ("card_id","started_at");--> statement-breakpoint
CREATE INDEX "agent_runs_board_id_started_at_idx" ON "agent_run" USING btree ("board_id","started_at");--> statement-breakpoint
CREATE INDEX "agent_runs_live_heartbeat_idx" ON "agent_run" USING btree ("heartbeat_at") WHERE "agent_run"."status" in ('running', 'blocked');--> statement-breakpoint
ALTER TABLE "activity_event" ADD CONSTRAINT "activity_event_agent_grant_id_oauth_grant_id_fk" FOREIGN KEY ("agent_grant_id") REFERENCES "public"."oauth_grant"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_agent_grant_id_oauth_grant_id_fk" FOREIGN KEY ("agent_grant_id") REFERENCES "public"."oauth_grant"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_event" ADD CONSTRAINT "activity_events_actor_kind_ck" CHECK ("activity_event"."actor_kind" in ('user', 'apiKey', 'agent', 'system', 'support'));--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comments_author_kind_ck" CHECK ("comment"."author_kind" in ('user', 'apiKey', 'agent', 'system'));--> statement-breakpoint
ALTER TABLE "automation_action" DROP CONSTRAINT "automation_actions_type_ck";--> statement-breakpoint
ALTER TABLE "automation_run" ADD COLUMN "card_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_run" ADD COLUMN "action_type" text;--> statement-breakpoint
ALTER TABLE "automation_run" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD COLUMN "owner_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD COLUMN "owner_agent_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."card"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoint_owner_api_key_id_workspace_api_key_id_fk" FOREIGN KEY ("owner_api_key_id") REFERENCES "public"."workspace_api_key"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoint_owner_agent_grant_id_oauth_grant_id_fk" FOREIGN KEY ("owner_agent_grant_id") REFERENCES "public"."oauth_grant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_runs_card_id_idx" ON "automation_run" USING btree ("card_id") WHERE "automation_run"."card_id" is not null;--> statement-breakpoint
CREATE INDEX "webhook_endpoints_owner_api_key_idx" ON "webhook_endpoint" USING btree ("owner_api_key_id") WHERE "webhook_endpoint"."owner_api_key_id" is not null;--> statement-breakpoint
CREATE INDEX "webhook_endpoints_owner_agent_grant_idx" ON "webhook_endpoint" USING btree ("owner_agent_grant_id") WHERE "webhook_endpoint"."owner_agent_grant_id" is not null;--> statement-breakpoint
ALTER TABLE "automation_action" ADD CONSTRAINT "automation_actions_type_ck" CHECK ("automation_action"."type" in ('add_labels', 'remove_labels', 'add_assignees', 'remove_assignees', 'apply_checklists', 'set_due_date', 'clear_due_date', 'set_completion', 'move_to_list', 'move_to_top', 'move_to_bottom', 'populate_custom_field', 'post_comment', 'call_webhook'));--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoints_owner_ck" CHECK ("webhook_endpoint"."owner_api_key_id" is null or "webhook_endpoint"."owner_agent_grant_id" is null);
