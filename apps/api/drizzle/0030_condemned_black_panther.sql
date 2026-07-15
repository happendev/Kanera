CREATE TYPE "public"."workspace_kind" AS ENUM('standard', 'board');--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "kind" "workspace_kind" DEFAULT 'standard' NOT NULL;