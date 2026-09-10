ALTER TABLE "user" ADD COLUMN "theme" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "accent" text;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "users_theme_ck" CHECK ("user"."theme" in ('light', 'paper', 'dark', 'carbon'));--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "users_accent_ck" CHECK ("user"."accent" in ('default', 'blue', 'green', 'violet', 'pink', 'graphite'));