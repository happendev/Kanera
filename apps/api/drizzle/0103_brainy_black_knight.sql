CREATE TABLE "card_priority_receipt" (
	"target_user_id" uuid PRIMARY KEY NOT NULL,
	"changed_at" timestamp with time zone,
	"seen_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "card_priority_receipt" ADD CONSTRAINT "card_priority_receipt_target_user_id_user_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;