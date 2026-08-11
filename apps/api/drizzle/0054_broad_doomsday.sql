CREATE TABLE "scratchpad_note" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"position" numeric(20, 10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scratchpad_note_attachment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"scratchpad_note_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"file_key" text NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scratchpad_note" ADD CONSTRAINT "scratchpad_note_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scratchpad_note" ADD CONSTRAINT "scratchpad_note_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scratchpad_note_attachment" ADD CONSTRAINT "scratchpad_note_attachment_scratchpad_note_id_scratchpad_note_id_fk" FOREIGN KEY ("scratchpad_note_id") REFERENCES "public"."scratchpad_note"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scratchpad_note_attachment" ADD CONSTRAINT "scratchpad_note_attachment_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scratchpad_notes_user_position_idx" ON "scratchpad_note" USING btree ("user_id","position");--> statement-breakpoint
CREATE INDEX "scratchpad_notes_client_id_idx" ON "scratchpad_note" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "scratchpad_note_attachments_client_id_idx" ON "scratchpad_note_attachment" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "scratchpad_note_attachments_note_id_idx" ON "scratchpad_note_attachment" USING btree ("scratchpad_note_id");