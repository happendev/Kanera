CREATE TYPE "public"."workspace_api_key_kind" AS ENUM('workspace', 'personal');--> statement-breakpoint
ALTER TABLE "workspace_api_key" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_api_key" ALTER COLUMN "name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_api_key" ADD COLUMN "kind" "workspace_api_key_kind" DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
CREATE INDEX "workspace_api_keys_creator_active_idx" ON "workspace_api_key" USING btree ("created_by_id","created_at") WHERE "workspace_api_key"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "workspace_api_key" ADD CONSTRAINT "workspace_api_keys_kind_shape" CHECK (("workspace_api_key"."kind" = 'workspace' and "workspace_api_key"."workspace_id" is not null and "workspace_api_key"."name" is not null)
        or ("workspace_api_key"."kind" = 'personal' and "workspace_api_key"."workspace_id" is null));