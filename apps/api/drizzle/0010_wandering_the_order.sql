ALTER TABLE "client" ADD COLUMN "seat_limit" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
-- Backfill purchased capacity to current usage so existing orgs own exactly what they already bill for.
-- Mirrors countActiveSeats(): active members + active paid guest seats, floored at 1. The hourly seat
-- reconcile sweep corrects any org whose live Stripe quantity had drifted from this.
UPDATE "client" SET "seat_limit" = GREATEST(
  1,
  (SELECT count(*)::int FROM "user" u WHERE u."client_id" = "client"."id" AND u."suspended_at" IS NULL)
  + (SELECT count(*)::int FROM "client_guest_seat" gs
       JOIN "user" gu ON gu."id" = gs."user_id"
      WHERE gs."client_id" = "client"."id" AND gu."suspended_at" IS NULL)
);
