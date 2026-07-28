CREATE TABLE "work_view_share" (
	"view_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_view_share_view_id_user_id_pk" PRIMARY KEY("view_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "work_view" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"client_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"lens" text NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"definition_version" integer DEFAULT 1 NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_views_lens_ck" CHECK ("work_view"."lens" in ('my', 'team', 'portfolio')),
	CONSTRAINT "work_views_visibility_ck" CHECK ("work_view"."visibility" in ('private', 'organisation')),
	CONSTRAINT "work_views_definition_version_ck" CHECK ("work_view"."definition_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "work_view_share" ADD CONSTRAINT "work_view_share_view_id_work_view_id_fk" FOREIGN KEY ("view_id") REFERENCES "public"."work_view"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_view_share" ADD CONSTRAINT "work_view_share_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_view" ADD CONSTRAINT "work_view_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_view" ADD CONSTRAINT "work_view_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_view_shares_user_idx" ON "work_view_share" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "work_views_owner_updated_idx" ON "work_view" USING btree ("owner_id","updated_at");--> statement-breakpoint
CREATE INDEX "work_views_client_visibility_idx" ON "work_view" USING btree ("client_id","visibility","updated_at");--> statement-breakpoint
DROP INDEX "card_assignees_user_id_idx";--> statement-breakpoint
CREATE INDEX "card_assignees_user_card_idx" ON "card_assignee" USING btree ("user_id","card_id");--> statement-breakpoint
ALTER TABLE "assigned_work_separator" RENAME TO "global_work_separator";--> statement-breakpoint
ALTER TABLE "global_work_separator" DROP CONSTRAINT "assigned_work_separators_color_ck";--> statement-breakpoint
ALTER TABLE "global_work_separator" DROP CONSTRAINT "assigned_work_separator_workspace_id_workspace_id_fk";
--> statement-breakpoint
ALTER TABLE "global_work_separator" DROP CONSTRAINT "assigned_work_separator_target_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "global_work_separator" DROP CONSTRAINT "assigned_work_separator_list_id_list_id_fk";
--> statement-breakpoint
ALTER TABLE "global_work_separator" DROP CONSTRAINT "assigned_work_separator_created_by_id_user_id_fk";
--> statement-breakpoint
DROP INDEX "assigned_work_separators_target_list_position_idx";--> statement-breakpoint
DROP INDEX "assigned_work_separators_target_user_idx";--> statement-breakpoint
DROP INDEX "assigned_work_separators_list_id_idx";--> statement-breakpoint
ALTER TABLE "global_work_separator" ADD CONSTRAINT "global_work_separator_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_work_separator" ADD CONSTRAINT "global_work_separator_target_user_id_user_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_work_separator" ADD CONSTRAINT "global_work_separator_list_id_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_work_separator" ADD CONSTRAINT "global_work_separator_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "global_work_separators_target_list_position_idx" ON "global_work_separator" USING btree ("workspace_id","target_user_id","list_id","position");--> statement-breakpoint
CREATE INDEX "global_work_separators_target_user_idx" ON "global_work_separator" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX "global_work_separators_list_id_idx" ON "global_work_separator" USING btree ("list_id");--> statement-breakpoint
ALTER TABLE "global_work_separator" ADD CONSTRAINT "global_work_separators_color_ck" CHECK ("global_work_separator"."color" in ('rose', 'pink', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'gray', 'olive', 'brown'));
