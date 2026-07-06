ALTER TABLE "support_session" DROP CONSTRAINT "support_session_superadmin_user_id_user_id_fk";
--> statement-breakpoint
DROP INDEX "support_sessions_superadmin_user_id_idx";--> statement-breakpoint
ALTER TABLE "support_session" ADD COLUMN "admin_user_id" uuid;--> statement-breakpoint
ALTER TABLE "support_session" ADD COLUMN "admin_email" text NOT NULL;--> statement-breakpoint
ALTER TABLE "support_session" ADD CONSTRAINT "support_session_admin_user_id_admin_user_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_sessions_admin_user_id_idx" ON "support_session" USING btree ("admin_user_id");--> statement-breakpoint
ALTER TABLE "support_session" DROP COLUMN "superadmin_user_id";--> statement-breakpoint
ALTER TABLE "support_session" DROP COLUMN "superadmin_email";