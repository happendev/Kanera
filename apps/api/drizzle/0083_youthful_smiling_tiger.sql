ALTER TABLE "user" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "users_locale_ck" CHECK ("user"."locale" in ('en-US', 'en-GB', 'es', 'pt-BR', 'fr', 'de', 'ja'));--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD COLUMN "locale" text DEFAULT 'en-GB' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoints_locale_ck" CHECK ("webhook_endpoint"."locale" in ('en-US', 'en-GB', 'es', 'pt-BR', 'fr', 'de', 'ja'));
