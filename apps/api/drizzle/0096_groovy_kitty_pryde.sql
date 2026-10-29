CREATE TABLE "card_github_pull" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"client_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"repo_full_name" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"head_ref" text NOT NULL,
	"state" text NOT NULL,
	"additions" integer,
	"deletions" integer,
	"github_updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_github_pulls_state_ck" CHECK ("card_github_pull"."state" in ('draft', 'open', 'merged', 'closed'))
);
--> statement-breakpoint
ALTER TABLE "card_github_pull" ADD CONSTRAINT "card_github_pull_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_github_pull" ADD CONSTRAINT "card_github_pull_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "card_github_pulls_card_repo_number_uq" ON "card_github_pull" USING btree ("card_id","repo_full_name","number");--> statement-breakpoint
CREATE INDEX "card_github_pulls_client_repo_number_idx" ON "card_github_pull" USING btree ("client_id","repo_full_name","number");