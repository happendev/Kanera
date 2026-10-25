ALTER TABLE "work_view" DROP CONSTRAINT "work_views_lens_ck";--> statement-breakpoint
ALTER TABLE "client" DROP COLUMN "portfolio_enabled";--> statement-breakpoint
-- The Portfolio page is gone, so views saved on that lens have nothing to open them.
DELETE FROM "work_view" WHERE "lens" = 'portfolio';--> statement-breakpoint
ALTER TABLE "work_view" ADD CONSTRAINT "work_views_lens_ck" CHECK ("work_view"."lens" in ('my', 'team'));
