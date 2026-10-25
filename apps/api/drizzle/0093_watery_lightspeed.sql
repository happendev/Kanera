ALTER TABLE "automation_in_progress_run" ADD COLUMN "threshold_seconds" integer;--> statement-breakpoint
ALTER TABLE "automation" ADD COLUMN "trigger_threshold_source" text;--> statement-breakpoint
ALTER TABLE "automation" ADD COLUMN "trigger_threshold_amount" integer;--> statement-breakpoint
ALTER TABLE "automation" ADD COLUMN "trigger_threshold_unit" text;--> statement-breakpoint
ALTER TABLE "automation" ADD COLUMN "trigger_include_existing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "automation" ADD CONSTRAINT "automations_trigger_threshold_source_ck" CHECK ("automation"."trigger_threshold_source" is null or "automation"."trigger_threshold_source" in ('workspace', 'fixed', 'custom_field'));--> statement-breakpoint
ALTER TABLE "automation" ADD CONSTRAINT "automations_trigger_threshold_unit_ck" CHECK ("automation"."trigger_threshold_unit" is null or "automation"."trigger_threshold_unit" in ('hours', 'days'));--> statement-breakpoint
ALTER TABLE "automation" ADD CONSTRAINT "automations_trigger_threshold_amount_ck" CHECK ("automation"."trigger_threshold_amount" is null or ("automation"."trigger_threshold_amount" between 1 and 87600));