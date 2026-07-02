CREATE TABLE "support_session" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"superadmin_user_id" uuid,
	"superadmin_email" text NOT NULL,
	"target_client_id" uuid,
	"target_org_name" text NOT NULL,
	"target_user_id" uuid,
	"target_user_email" text NOT NULL,
	"reason" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "activity_event" ADD COLUMN "support_session_id" uuid;--> statement-breakpoint
ALTER TABLE "activity_event" ADD COLUMN "support_actor_email" text;--> statement-breakpoint
ALTER TABLE "support_session" ADD CONSTRAINT "support_session_superadmin_user_id_user_id_fk" FOREIGN KEY ("superadmin_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_session" ADD CONSTRAINT "support_session_target_client_id_client_id_fk" FOREIGN KEY ("target_client_id") REFERENCES "public"."client"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_session" ADD CONSTRAINT "support_session_target_user_id_user_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_sessions_superadmin_user_id_idx" ON "support_session" USING btree ("superadmin_user_id");--> statement-breakpoint
CREATE INDEX "support_sessions_target_client_id_idx" ON "support_session" USING btree ("target_client_id");--> statement-breakpoint
ALTER TABLE "activity_event" ADD CONSTRAINT "activity_event_support_session_id_support_session_id_fk" FOREIGN KEY ("support_session_id") REFERENCES "public"."support_session"("id") ON DELETE set null ON UPDATE no action;