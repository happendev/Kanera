INSERT INTO "board_member" ("board_id", "user_id", "role")
SELECT b."id", wm."user_id", wm."role"
FROM "board" b
JOIN "workspace_member" wm ON wm."workspace_id" = b."workspace_id"
ON CONFLICT ("board_id", "user_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "board" DROP COLUMN "visibility";--> statement-breakpoint
DROP TYPE "public"."board_visibility";
