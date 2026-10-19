ALTER TABLE "user" ADD COLUMN "getting_started_hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "getting_started_dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "getting_started_used" jsonb DEFAULT '{}'::jsonb NOT NULL;