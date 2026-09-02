CREATE TABLE "csv_import" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"created_by_id" uuid NOT NULL,
	"status" text DEFAULT 'analyzed' NOT NULL,
	"source_file_key" text NOT NULL,
	"source_file_name" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"source" jsonb NOT NULL,
	"column_mapping" jsonb,
	"mappings" jsonb,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "csv_imports_status_ck" CHECK ("csv_import"."status" in ('analyzed', 'ready', 'importing', 'completed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "csv_import" ADD CONSTRAINT "csv_import_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csv_import" ADD CONSTRAINT "csv_import_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csv_import" ADD CONSTRAINT "csv_import_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "csv_import_workspace_created_at_idx" ON "csv_import" USING btree ("workspace_id","created_at");