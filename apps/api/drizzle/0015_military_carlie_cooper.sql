CREATE TABLE "automation_run_stats" (
	"automation_id" uuid PRIMARY KEY NOT NULL,
	"run_count" integer DEFAULT 0 NOT NULL,
	"effectful_run_count" integer DEFAULT 0 NOT NULL,
	"noop_run_count" integer DEFAULT 0 NOT NULL,
	"failed_run_count" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_effectful_run_at" timestamp with time zone,
	"last_noop_run_at" timestamp with time zone,
	"last_failed_run_at" timestamp with time zone,
	"last_failure_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_run_stats" ADD CONSTRAINT "automation_run_stats_automation_id_automation_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automation"("id") ON DELETE cascade ON UPDATE no action;