CREATE TABLE "oauth_device_code" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"grant_id" uuid,
	"user_id" uuid,
	"scopes" text[] NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"polling_interval" integer NOT NULL,
	"last_polled_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_device_codes_status_ck" CHECK ("oauth_device_code"."status" in ('pending', 'approved', 'denied', 'consumed'))
);
--> statement-breakpoint
ALTER TABLE "oauth_device_code" ADD CONSTRAINT "oauth_device_code_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_device_code" ADD CONSTRAINT "oauth_device_code_grant_id_oauth_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_device_code" ADD CONSTRAINT "oauth_device_code_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_device_codes_device_code_uidx" ON "oauth_device_code" USING btree ("device_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_device_codes_user_code_uidx" ON "oauth_device_code" USING btree ("user_code_hash");--> statement-breakpoint
CREATE INDEX "oauth_device_codes_client_idx" ON "oauth_device_code" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "oauth_device_codes_user_idx" ON "oauth_device_code" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "oauth_device_codes_expiry_idx" ON "oauth_device_code" USING btree ("expires_at");