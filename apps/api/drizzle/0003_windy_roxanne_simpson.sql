CREATE TABLE "assigned_work_separator" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target_user_id" uuid NOT NULL,
	"list_id" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"color" text,
	"position" numeric(20, 10) NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assigned_work_separator" ADD CONSTRAINT "assigned_work_separator_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assigned_work_separator" ADD CONSTRAINT "assigned_work_separator_target_user_id_user_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assigned_work_separator" ADD CONSTRAINT "assigned_work_separator_list_id_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assigned_work_separator" ADD CONSTRAINT "assigned_work_separator_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assigned_work_separators_target_list_position_idx" ON "assigned_work_separator" USING btree ("workspace_id","target_user_id","list_id","position");--> statement-breakpoint
CREATE INDEX "assigned_work_separators_workspace_idx" ON "assigned_work_separator" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "assigned_work_separators_target_user_idx" ON "assigned_work_separator" USING btree ("target_user_id");