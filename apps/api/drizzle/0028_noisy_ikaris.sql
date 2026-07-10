CREATE TYPE "public"."oauth_client_kind" AS ENUM('public', 'service');--> statement-breakpoint
CREATE TYPE "public"."oauth_token_kind" AS ENUM('access', 'refresh');--> statement-breakpoint
CREATE TABLE "oauth_authorization_code" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"grant_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_authorization_code_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "oauth_client" (
	"client_id" text PRIMARY KEY NOT NULL,
	"kind" "oauth_client_kind" NOT NULL,
	"name" text NOT NULL,
	"client_secret_hash" text,
	"redirect_uris" text[] DEFAULT '{}'::text[] NOT NULL,
	"grant_types" text[] NOT NULL,
	"workspace_id" uuid,
	"api_key_id" uuid,
	"created_by_id" uuid,
	"max_scope" text,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_grant" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"scopes" text[] NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_token" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" "oauth_token_kind" NOT NULL,
	"token_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"grant_id" uuid,
	"user_id" uuid,
	"api_key_id" uuid,
	"family_id" uuid NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_token_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "oauth_authorization_code" ADD CONSTRAINT "oauth_authorization_code_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_code" ADD CONSTRAINT "oauth_authorization_code_grant_id_oauth_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_api_key_id_workspace_api_key_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."workspace_api_key"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grant" ADD CONSTRAINT "oauth_grant_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grant" ADD CONSTRAINT "oauth_grant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_token" ADD CONSTRAINT "oauth_token_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_token" ADD CONSTRAINT "oauth_token_grant_id_oauth_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_token" ADD CONSTRAINT "oauth_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_token" ADD CONSTRAINT "oauth_token_api_key_id_workspace_api_key_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."workspace_api_key"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_codes_client_idx" ON "oauth_authorization_code" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "oauth_clients_workspace_idx" ON "oauth_client" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "oauth_clients_creator_idx" ON "oauth_client" USING btree ("created_by_id","created_at");--> statement-breakpoint
CREATE INDEX "oauth_grants_user_idx" ON "oauth_grant" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "oauth_grants_client_idx" ON "oauth_grant" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "oauth_tokens_family_idx" ON "oauth_token" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "oauth_tokens_user_idx" ON "oauth_token" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "oauth_tokens_api_key_idx" ON "oauth_token" USING btree ("api_key_id","created_at");