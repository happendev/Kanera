CREATE TABLE "standalone_board_group" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"client_id" uuid NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_event" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_event" ADD COLUMN "client_id" uuid;--> statement-breakpoint
UPDATE "activity_event" ae SET "client_id" = w."client_id" FROM "workspace" w WHERE ae."workspace_id" = w."id";--> statement-breakpoint
ALTER TABLE "board" ADD COLUMN "standalone_group_id" uuid;--> statement-breakpoint
ALTER TABLE "standalone_board_group" ADD CONSTRAINT "standalone_board_group_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "standalone_board_groups_client_id_title_idx" ON "standalone_board_group" USING btree ("client_id","title");--> statement-breakpoint
ALTER TABLE "activity_event" ADD CONSTRAINT "activity_event_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board" ADD CONSTRAINT "board_standalone_group_id_standalone_board_group_id_fk" FOREIGN KEY ("standalone_group_id") REFERENCES "public"."standalone_board_group"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_events_client_id_created_at_idx" ON "activity_event" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "boards_standalone_group_id_idx" ON "board" USING btree ("standalone_group_id");
