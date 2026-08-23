DROP INDEX "event_outbox_pending_idx";--> statement-breakpoint
CREATE INDEX "automations_trigger_list_idx" ON "automation" USING btree ("workspace_id","trigger_type","trigger_list_id","position") WHERE "automation"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "board_members_assigned_items_only_idx" ON "board_member" USING btree ("board_id") WHERE "board_member"."assigned_items_only";--> statement-breakpoint
CREATE INDEX "comments_author_id_idx" ON "comment" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "event_outbox_pending_idx" ON "event_outbox" USING btree ("created_at","id") WHERE "event_outbox"."realtime_dispatched" = false or "event_outbox"."webhooks_enqueued" = false;