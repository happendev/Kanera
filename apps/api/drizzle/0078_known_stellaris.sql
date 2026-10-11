CREATE TABLE "card_attachment_upload_link" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"token_hash" text NOT NULL,
	"card_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"claims" jsonb NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"source" text DEFAULT 'attachment' NOT NULL,
	"comment_id" uuid,
	"max_bytes" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"attachment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_attachment_upload_link_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "card_attachment_upload_link_source_ck" CHECK ("card_attachment_upload_link"."source" in ('description', 'attachment', 'comment'))
);
--> statement-breakpoint
ALTER TABLE "card_attachment_upload_link" ADD CONSTRAINT "card_attachment_upload_link_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_attachment_upload_link" ADD CONSTRAINT "card_attachment_upload_link_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_attachment_upload_link" ADD CONSTRAINT "card_attachment_upload_link_comment_id_comment_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_attachment_upload_link" ADD CONSTRAINT "card_attachment_upload_link_attachment_id_card_attachment_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."card_attachment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "card_attachment_upload_link_expires_idx" ON "card_attachment_upload_link" USING btree ("expires_at");