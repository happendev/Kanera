CREATE TABLE "card_priority" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"target_user_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"position" numeric(20, 10) NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "card_priority" ADD CONSTRAINT "card_priority_target_user_id_user_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_priority" ADD CONSTRAINT "card_priority_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_priority" ADD CONSTRAINT "card_priority_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "card_priorities_user_card_uq" ON "card_priority" USING btree ("target_user_id","card_id");--> statement-breakpoint
CREATE INDEX "card_priorities_user_position_idx" ON "card_priority" USING btree ("target_user_id","position","card_id");--> statement-breakpoint
CREATE INDEX "card_priorities_card_id_idx" ON "card_priority" USING btree ("card_id");