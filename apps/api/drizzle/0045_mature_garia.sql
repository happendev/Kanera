-- Credentials issued before resource binding cannot be assigned a trustworthy audience. Revoke
-- them during the contract upgrade; clients remain registered and can authorize again.
DELETE FROM "oauth_authorization_code";--> statement-breakpoint
DELETE FROM "oauth_device_code";--> statement-breakpoint
DELETE FROM "oauth_token";--> statement-breakpoint
DELETE FROM "oauth_grant";--> statement-breakpoint
ALTER TABLE "oauth_authorization_code" ADD COLUMN "resource" text NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_device_code" ADD COLUMN "resource" text NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_grant" ADD COLUMN "resource" text NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_token" ADD COLUMN "resource" text NOT NULL;
