CREATE TABLE "mcp_event_delivery" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"subscription_id" text NOT NULL,
	"outbox_event_id" uuid,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"response_status" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_delivery_status_ck" CHECK ("mcp_event_delivery"."status" in ('queued', 'delivering', 'success', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "mcp_event_subscription" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"board_id" uuid,
	"user_id" uuid NOT NULL,
	"owner_api_key_id" uuid,
	"owner_agent_grant_id" uuid,
	"owner_service_client_id" text,
	"name" text NOT NULL,
	"arguments" jsonb NOT NULL,
	"url" text NOT NULL,
	"encrypted_secret" text NOT NULL,
	"previous_encrypted_secret" text,
	"secret_rotation_until" timestamp with time zone,
	"verified_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_delivery_at" timestamp with time zone,
	"last_error" text,
	"failed_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_subscription_owner_ck" CHECK (("mcp_event_subscription"."owner_api_key_id" is null) <> ("mcp_event_subscription"."owner_agent_grant_id" is null)),
	CONSTRAINT "mcp_subscription_last_error_ck" CHECK ("mcp_event_subscription"."last_error" in ('connection_refused', 'timeout', 'tls_error', 'http_4xx', 'http_5xx', 'challenge_failed'))
);
--> statement-breakpoint
ALTER TABLE "event_outbox" ADD COLUMN "actor" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_event_delivery" ADD CONSTRAINT "mcp_event_delivery_subscription_id_mcp_event_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."mcp_event_subscription"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_event_delivery" ADD CONSTRAINT "mcp_event_delivery_outbox_event_id_event_outbox_id_fk" FOREIGN KEY ("outbox_event_id") REFERENCES "public"."event_outbox"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_event_subscription" ADD CONSTRAINT "mcp_event_subscription_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_event_subscription" ADD CONSTRAINT "mcp_event_subscription_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_event_subscription" ADD CONSTRAINT "mcp_event_subscription_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_event_subscription" ADD CONSTRAINT "mcp_event_subscription_owner_api_key_id_workspace_api_key_id_fk" FOREIGN KEY ("owner_api_key_id") REFERENCES "public"."workspace_api_key"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_event_subscription" ADD CONSTRAINT "mcp_event_subscription_owner_agent_grant_id_oauth_grant_id_fk" FOREIGN KEY ("owner_agent_grant_id") REFERENCES "public"."oauth_grant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_event_subscription" ADD CONSTRAINT "mcp_event_subscription_owner_service_client_id_oauth_client_client_id_fk" FOREIGN KEY ("owner_service_client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_delivery_pending_idx" ON "mcp_event_delivery" USING btree ("next_attempt_at") WHERE "mcp_event_delivery"."status" in ('queued', 'delivering');--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_delivery_subscription_outbox_uq" ON "mcp_event_delivery" USING btree ("subscription_id","outbox_event_id");--> statement-breakpoint
CREATE INDEX "mcp_subscription_workspace_event_idx" ON "mcp_event_subscription" USING btree ("workspace_id","name","expires_at");--> statement-breakpoint
CREATE INDEX "mcp_subscription_owner_key_idx" ON "mcp_event_subscription" USING btree ("owner_api_key_id","expires_at");--> statement-breakpoint
CREATE INDEX "mcp_subscription_owner_grant_idx" ON "mcp_event_subscription" USING btree ("owner_agent_grant_id","expires_at");
