ALTER TABLE "client" ADD COLUMN "permanent_deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "permanent_deletion_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "needs_organisation_on_login_at" timestamp with time zone;