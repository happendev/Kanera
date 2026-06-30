ALTER TYPE "public"."automation_trigger_type" ADD VALUE 'card_label_set';--> statement-breakpoint
ALTER TABLE "automation" ADD COLUMN "trigger_label_id" uuid;