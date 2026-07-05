CREATE TABLE "mfa_credential" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid,
	"admin_user_id" uuid,
	"encrypted_secret" text NOT NULL,
	"enabled_at" timestamp with time zone,
	"recovery_codes_acknowledged_at" timestamp with time zone,
	"failed_verify_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_totp_step" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mfa_credentials_one_owner_ck" CHECK (num_nonnulls("mfa_credential"."user_id", "mfa_credential"."admin_user_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "mfa_recovery_code" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"credential_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "require_mfa" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mfa_credential" ADD CONSTRAINT "mfa_credential_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_credential" ADD CONSTRAINT "mfa_credential_admin_user_id_admin_user_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_recovery_code" ADD CONSTRAINT "mfa_recovery_code_credential_id_mfa_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."mfa_credential"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mfa_credentials_user_id_uq" ON "mfa_credential" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mfa_credentials_admin_user_id_uq" ON "mfa_credential" USING btree ("admin_user_id");--> statement-breakpoint
CREATE INDEX "mfa_recovery_codes_credential_id_idx" ON "mfa_recovery_code" USING btree ("credential_id");