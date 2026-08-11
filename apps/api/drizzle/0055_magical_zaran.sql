DROP INDEX "scratchpad_notes_user_position_idx";--> statement-breakpoint
CREATE INDEX "scratchpad_notes_user_client_position_idx" ON "scratchpad_note" USING btree ("user_id","client_id","position");