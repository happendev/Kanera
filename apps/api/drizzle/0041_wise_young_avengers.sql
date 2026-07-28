ALTER TABLE "note" ADD COLUMN "last_edited_by_id" uuid;--> statement-breakpoint
ALTER TABLE "note" ADD COLUMN "last_edited_at" timestamp with time zone;--> statement-breakpoint
UPDATE "note" SET "last_edited_by_id" = "owner_id", "last_edited_at" = "updated_at";--> statement-breakpoint
ALTER TABLE "note" ALTER COLUMN "last_edited_by_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "note" ALTER COLUMN "last_edited_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "note" ALTER COLUMN "last_edited_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_last_edited_by_id_user_id_fk" FOREIGN KEY ("last_edited_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;
