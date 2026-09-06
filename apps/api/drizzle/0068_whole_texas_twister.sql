ALTER TABLE "github_app" ADD COLUMN "encrypted_client_id" text;--> statement-breakpoint
ALTER TABLE "github_app" ADD COLUMN "encrypted_client_secret" text;--> statement-breakpoint
CREATE UNIQUE INDEX "github_app_installation_installation_uq" ON "github_app_installation" USING btree ("installation_id");