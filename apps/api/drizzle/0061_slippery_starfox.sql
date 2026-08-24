ALTER TABLE "email_queue" ADD COLUMN "processing_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "push_queue" ADD COLUMN "processing_lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "email_queue_status_lease_idx" ON "email_queue" USING btree ("status","processing_lease_expires_at");--> statement-breakpoint
CREATE INDEX "push_queue_status_lease_idx" ON "push_queue" USING btree ("status","processing_lease_expires_at");