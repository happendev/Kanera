CREATE TABLE "automation_inactive_run" (
	"automation_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"inactive_at" timestamp with time zone NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_inactive_run_automation_id_card_id_pk" PRIMARY KEY("automation_id","card_id")
);
--> statement-breakpoint
ALTER TABLE "automation" DROP CONSTRAINT "automations_trigger_type_ck";--> statement-breakpoint
ALTER TABLE "automation_inactive_run" ADD CONSTRAINT "automation_inactive_run_automation_id_automation_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_inactive_run" ADD CONSTRAINT "automation_inactive_run_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_inactive_runs_card_id_idx" ON "automation_inactive_run" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "cards_active_incomplete_updated_at_idx" ON "card" USING btree ("updated_at","id") WHERE "card"."completed_at" is null and "card"."archived_at" is null;--> statement-breakpoint
ALTER TABLE "automation_due_date_run" ADD COLUMN "trigger_days_before" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation" ADD COLUMN "trigger_custom_field_id" uuid;--> statement-breakpoint
ALTER TABLE "automation" ADD COLUMN "trigger_custom_field_value" jsonb;--> statement-breakpoint
ALTER TABLE "automation" ADD COLUMN "trigger_days_before" integer;--> statement-breakpoint
ALTER TABLE "automation_due_date_run" ADD CONSTRAINT "automation_due_date_runs_trigger_days_before_ck" CHECK ("automation_due_date_run"."trigger_days_before" between 0 and 3650);--> statement-breakpoint
ALTER TABLE "automation" ADD CONSTRAINT "automations_trigger_days_before_ck" CHECK ("automation"."trigger_days_before" is null or ("automation"."trigger_days_before" between 1 and 3650));--> statement-breakpoint
ALTER TABLE "automation" ADD CONSTRAINT "automations_trigger_type_ck" CHECK ("automation"."trigger_type" in ('card_enters_list', 'card_leaves_list', 'due_date_arrives', 'due_date_approaching', 'card_becomes_inactive', 'all_checklist_items_complete', 'card_assigned_to_user', 'card_marked_complete', 'card_label_set', 'custom_field_value_changed'));
