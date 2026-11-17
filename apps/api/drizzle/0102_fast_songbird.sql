CREATE TABLE "user_identity" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_subject" text NOT NULL,
	"email" "citext" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "user_identity_provider_ck" CHECK ("user_identity"."provider" in ('google', 'microsoft', 'github'))
);
--> statement-breakpoint
CREATE TABLE "auth_provider_flow" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"provider" text NOT NULL,
	"intent" text NOT NULL,
	"state_hash" text NOT NULL,
	"browser_nonce_hash" text NOT NULL,
	"code_verifier" text NOT NULL,
	"link_user_id" uuid,
	"invite_token" text,
	"board_invite_token" text,
	"return_url" text,
	"locale" text,
	"analytics_attribution" jsonb,
	"handoff_hash" text,
	"result" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_provider_flow_provider_ck" CHECK ("auth_provider_flow"."provider" in ('google', 'microsoft', 'github')),
	CONSTRAINT "auth_provider_flow_intent_ck" CHECK ("auth_provider_flow"."intent" in ('login', 'link')),
	CONSTRAINT "auth_provider_flow_locale_ck" CHECK ("auth_provider_flow"."locale" in ('en-US', 'en-GB', 'es', 'pt-BR', 'fr', 'de', 'ja', 'nl', 'nb', 'zh-CN', 'zh-TW'))
);
--> statement-breakpoint
ALTER TABLE "email_verification_code" DROP CONSTRAINT "email_verification_codes_purpose_ck";--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "refresh_token" ADD COLUMN "auth_method" text DEFAULT 'password' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_identity" ADD CONSTRAINT "user_identity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_provider_flow" ADD CONSTRAINT "auth_provider_flow_link_user_id_user_id_fk" FOREIGN KEY ("link_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_identity_provider_subject_uq" ON "user_identity" USING btree ("provider","provider_subject");--> statement-breakpoint
CREATE UNIQUE INDEX "user_identity_user_provider_uq" ON "user_identity" USING btree ("user_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_provider_flow_state_hash_uq" ON "auth_provider_flow" USING btree ("state_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_provider_flow_handoff_hash_uq" ON "auth_provider_flow" USING btree ("handoff_hash");--> statement-breakpoint
CREATE INDEX "auth_provider_flow_expires_at_idx" ON "auth_provider_flow" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "email_verification_code" ADD CONSTRAINT "email_verification_codes_purpose_ck" CHECK ("email_verification_code"."purpose" in ('signup', 'email_change', 'identity_link', 'step_up'));--> statement-breakpoint
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_auth_method_ck" CHECK ("refresh_token"."auth_method" in ('password', 'google', 'microsoft', 'github'));