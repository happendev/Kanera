CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint
DROP INDEX "assigned_work_separators_workspace_idx";--> statement-breakpoint
DROP INDEX "board_invitations_token_hash_idx";--> statement-breakpoint
DROP INDEX "github_app_installation_client_idx";--> statement-breakpoint
CREATE INDEX "assigned_work_separators_list_id_idx" ON "assigned_work_separator" USING btree ("list_id");--> statement-breakpoint
CREATE INDEX "automation_due_date_runs_card_id_idx" ON "automation_due_date_run" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "card_attachments_file_name_trgm_idx" ON "card_attachment" USING gin (lower("file_name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "card_checklist_items_completed_at_idx" ON "card_checklist_item" USING btree ("completed_at","checklist_id") WHERE "card_checklist_item"."completed_at" is not null;--> statement-breakpoint
CREATE INDEX "card_checklist_template_applications_template_id_idx" ON "card_checklist_template_application" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "cards_title_trgm_idx" ON "card" USING gin (lower("title") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "cards_archived_at_idx" ON "card" USING btree ("archived_at") WHERE "card"."archived_at" is not null;--> statement-breakpoint
CREATE INDEX "notes_parent_note_id_idx" ON "note" USING btree ("parent_note_id") WHERE "note"."parent_note_id" is not null;--> statement-breakpoint
CREATE INDEX "notifications_activity_id_idx" ON "notification" USING btree ("activity_id") WHERE "notification"."activity_id" is not null;--> statement-breakpoint
CREATE INDEX "notifications_card_id_idx" ON "notification" USING btree ("card_id") WHERE "notification"."card_id" is not null;--> statement-breakpoint
CREATE INDEX "notifications_checklist_item_id_idx" ON "notification" USING btree ("checklist_item_id") WHERE "notification"."checklist_item_id" is not null;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_terminal_updated_at_idx" ON "webhook_delivery" USING btree ("status","updated_at") WHERE "webhook_delivery"."status" in ('success', 'failed');--> statement-breakpoint
CREATE INDEX "webhook_deliveries_outbox_event_id_idx" ON "webhook_delivery" USING btree ("outbox_event_id") WHERE "webhook_delivery"."outbox_event_id" is not null;
