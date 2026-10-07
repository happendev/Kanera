ALTER TABLE "mcp_event_subscription" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_event_subscription" ADD COLUMN "target_user_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_event_subscription" ADD CONSTRAINT "mcp_event_subscription_target_user_id_user_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_subscription_target_user_idx" ON "mcp_event_subscription" USING btree ("target_user_id","expires_at") WHERE "mcp_event_subscription"."target_user_id" is not null;--> statement-breakpoint
ALTER TABLE "mcp_event_subscription" ADD CONSTRAINT "mcp_subscription_scope_ck" CHECK (case when "mcp_event_subscription"."name" = 'priorities.changed'
    then "mcp_event_subscription"."target_user_id" = "mcp_event_subscription"."user_id" and "mcp_event_subscription"."workspace_id" is null and "mcp_event_subscription"."board_id" is null
    else "mcp_event_subscription"."workspace_id" is not null and "mcp_event_subscription"."target_user_id" is null end);