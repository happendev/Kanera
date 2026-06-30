CREATE TABLE "board_separator" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"board_id" uuid NOT NULL,
	"list_id" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"color" text,
	"position" numeric(20, 10) NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_separator" ADD CONSTRAINT "board_separator_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_separator" ADD CONSTRAINT "board_separator_list_id_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_separator" ADD CONSTRAINT "board_separator_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_separators_board_list_position_idx" ON "board_separator" USING btree ("board_id","list_id","position");--> statement-breakpoint
CREATE INDEX "board_separators_board_id_idx" ON "board_separator" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "board_separators_list_id_idx" ON "board_separator" USING btree ("list_id");