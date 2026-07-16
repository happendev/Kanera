CREATE TABLE "board_mirror_dirty_card" (
	"mirror_id" uuid NOT NULL,
	"source_card_id" uuid NOT NULL,
	"facets" text[] NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_mirror_dirty_card_mirror_id_source_card_id_pk" PRIMARY KEY("mirror_id","source_card_id")
);
--> statement-breakpoint
CREATE TABLE "board_mirror_list" (
	"mirror_id" uuid NOT NULL,
	"source_list_id" uuid NOT NULL,
	"target_list_id" uuid NOT NULL,
	CONSTRAINT "board_mirror_list_mirror_id_source_list_id_pk" PRIMARY KEY("mirror_id","source_list_id")
);
--> statement-breakpoint
CREATE TABLE "board_mirror" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"source_board_id" uuid NOT NULL,
	"target_board_id" uuid NOT NULL,
	"source_workspace_id" uuid NOT NULL,
	"target_workspace_id" uuid NOT NULL,
	"created_by_id" uuid NOT NULL,
	"paused_at" timestamp with time zone,
	"source_disabled_at" timestamp with time zone,
	"source_disabled_by_id" uuid,
	"cursor_event_created_at" timestamp with time zone NOT NULL,
	"cursor_event_id" uuid NOT NULL,
	"reconcile_requested_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_mirrors_distinct_boards_check" CHECK ("board_mirror"."source_board_id" <> "board_mirror"."target_board_id")
);
--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "board_linking_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "board_mirror_dirty_card" ADD CONSTRAINT "board_mirror_dirty_card_mirror_id_board_mirror_id_fk" FOREIGN KEY ("mirror_id") REFERENCES "public"."board_mirror"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_mirror_list" ADD CONSTRAINT "board_mirror_list_mirror_id_board_mirror_id_fk" FOREIGN KEY ("mirror_id") REFERENCES "public"."board_mirror"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_mirror_list" ADD CONSTRAINT "board_mirror_list_source_list_id_list_id_fk" FOREIGN KEY ("source_list_id") REFERENCES "public"."list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_mirror_list" ADD CONSTRAINT "board_mirror_list_target_list_id_list_id_fk" FOREIGN KEY ("target_list_id") REFERENCES "public"."list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_mirror" ADD CONSTRAINT "board_mirror_source_board_id_board_id_fk" FOREIGN KEY ("source_board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_mirror" ADD CONSTRAINT "board_mirror_target_board_id_board_id_fk" FOREIGN KEY ("target_board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_mirror" ADD CONSTRAINT "board_mirror_source_workspace_id_workspace_id_fk" FOREIGN KEY ("source_workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_mirror" ADD CONSTRAINT "board_mirror_target_workspace_id_workspace_id_fk" FOREIGN KEY ("target_workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_mirror" ADD CONSTRAINT "board_mirror_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_mirror" ADD CONSTRAINT "board_mirror_source_disabled_by_id_user_id_fk" FOREIGN KEY ("source_disabled_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_mirror_dirty_cards_ready_idx" ON "board_mirror_dirty_card" USING btree ("next_retry_at","updated_at");--> statement-breakpoint
CREATE INDEX "board_mirror_lists_target_list_idx" ON "board_mirror_list" USING btree ("target_list_id");--> statement-breakpoint
CREATE UNIQUE INDEX "board_mirrors_source_target_uq" ON "board_mirror" USING btree ("source_board_id","target_board_id");--> statement-breakpoint
CREATE INDEX "board_mirrors_active_source_idx" ON "board_mirror" USING btree ("source_board_id","next_retry_at") WHERE "board_mirror"."paused_at" is null and "board_mirror"."source_disabled_at" is null;--> statement-breakpoint
CREATE INDEX "external_links_mirror_card_source_idx" ON "external_link" USING btree ("external_id","provider","entity_id") WHERE "external_link"."provider" like 'mirror:%' and "external_link"."external_type" = 'card';