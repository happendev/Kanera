ALTER TABLE "client" ADD COLUMN "analytics_subscription_cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_analytics_milestone" ADD COLUMN "meaningful_work_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_analytics_milestone" ADD COLUMN "collaboration_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "analytics_trial_ended_at" timestamp with time zone;