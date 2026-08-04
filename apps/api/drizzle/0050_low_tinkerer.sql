CREATE TABLE "automation_monthly_usage" (
	"client_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"execution_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_monthly_usage_client_id_period_start_pk" PRIMARY KEY("client_id","period_start"),
	CONSTRAINT "automation_monthly_usage_execution_count_ck" CHECK ("automation_monthly_usage"."execution_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "automation_monthly_usage" ADD CONSTRAINT "automation_monthly_usage_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;