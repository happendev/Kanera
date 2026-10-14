ALTER TABLE "user" DROP CONSTRAINT "users_locale_ck";--> statement-breakpoint
ALTER TABLE "webhook_endpoint" DROP CONSTRAINT "webhook_endpoints_locale_ck";--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "users_locale_ck" CHECK ("user"."locale" in ('en-US', 'en-GB', 'es', 'pt-BR', 'fr', 'de', 'ja', 'nl', 'nb'));--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoints_locale_ck" CHECK ("webhook_endpoint"."locale" in ('en-US', 'en-GB', 'es', 'pt-BR', 'fr', 'de', 'ja', 'nl', 'nb'));