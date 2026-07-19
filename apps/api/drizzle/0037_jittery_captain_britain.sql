CREATE TABLE "workspace_analytics_milestone" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"activated_at" timestamp with time zone,
	"qualified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "analytics_excluded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "analytics_subscription_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_analytics_milestone" ADD CONSTRAINT "workspace_analytics_milestone_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;