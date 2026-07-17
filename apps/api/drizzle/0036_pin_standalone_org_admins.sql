-- Existing explicit grants retain their provenance so a later org-role demotion restores the role
-- the member had before promotion. Organisation authority still requires unrestricted visibility.
UPDATE "board_member" AS bm
SET "assigned_items_only" = false
FROM "board" AS b
INNER JOIN "workspace" AS w ON w."id" = b."workspace_id"
INNER JOIN "user" AS u ON u."client_id" = w."client_id"
WHERE bm."board_id" = b."id"
  AND bm."user_id" = u."id"
  AND w."kind" = 'board'
  AND u."client_role" IN ('owner', 'admin')
  AND u."removed_at" IS NULL
  AND u."deleted_at" IS NULL;
--> statement-breakpoint
-- Backfill missing inherited rows for standalone boards created before org-admin membership was
-- materialized. ON CONFLICT preserves any explicit observer/editor grant as described above.
INSERT INTO "board_member" ("board_id", "user_id", "role", "assigned_items_only", "pinned")
SELECT b."id", u."id", 'editor', false, true
FROM "board" AS b
INNER JOIN "workspace" AS w ON w."id" = b."workspace_id"
INNER JOIN "user" AS u ON u."client_id" = w."client_id"
WHERE w."kind" = 'board'
  AND u."client_role" IN ('owner', 'admin')
  AND u."removed_at" IS NULL
  AND u."deleted_at" IS NULL
ON CONFLICT ("board_id", "user_id") DO NOTHING;
