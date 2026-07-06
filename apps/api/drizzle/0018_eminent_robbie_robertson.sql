CREATE TYPE "public"."board_role" AS ENUM('editor', 'observer');--> statement-breakpoint
CREATE TYPE "public"."workspace_role" AS ENUM('admin', 'member');--> statement-breakpoint
-- Board-scoped roles collapse to editor/observer: the retired owner/admin board tiers become editor
-- (workspace admins carry board-admin power via pinned rows added below, not a board role).
ALTER TABLE "board_invitation_grant" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "board_invitation_grant" ALTER COLUMN "role" SET DATA TYPE "public"."board_role" USING (CASE WHEN "role"::text IN ('owner', 'admin') THEN 'editor' ELSE "role"::text END)::"public"."board_role";--> statement-breakpoint
ALTER TABLE "board_invitation_grant" ALTER COLUMN "role" SET DEFAULT 'editor';--> statement-breakpoint
ALTER TABLE "board_invitation" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "board_invitation" ALTER COLUMN "role" SET DATA TYPE "public"."board_role" USING (CASE WHEN "role"::text IN ('owner', 'admin') THEN 'editor' ELSE "role"::text END)::"public"."board_role";--> statement-breakpoint
ALTER TABLE "board_invitation" ALTER COLUMN "role" SET DEFAULT 'editor';--> statement-breakpoint
ALTER TABLE "board_member" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "board_member" ALTER COLUMN "role" SET DATA TYPE "public"."board_role" USING (CASE WHEN "role"::text IN ('owner', 'admin') THEN 'editor' ELSE "role"::text END)::"public"."board_role";--> statement-breakpoint
ALTER TABLE "board_member" ALTER COLUMN "role" SET DEFAULT 'editor';--> statement-breakpoint
-- Workspace-scoped roles collapse to admin/member: owner and admin merge to admin; editor and
-- observer merge to member (a plain member has no workspace-scoped mutation rights).
ALTER TABLE "invite_token" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "invite_token" ALTER COLUMN "role" SET DATA TYPE "public"."workspace_role" USING (CASE WHEN "role"::text IN ('owner', 'admin') THEN 'admin' ELSE 'member' END)::"public"."workspace_role";--> statement-breakpoint
ALTER TABLE "invite_token" ALTER COLUMN "role" SET DEFAULT 'member';--> statement-breakpoint
ALTER TABLE "invite_workspace_grant" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "invite_workspace_grant" ALTER COLUMN "role" SET DATA TYPE "public"."workspace_role" USING (CASE WHEN "role"::text IN ('owner', 'admin') THEN 'admin' ELSE 'member' END)::"public"."workspace_role";--> statement-breakpoint
ALTER TABLE "invite_workspace_grant" ALTER COLUMN "role" SET DEFAULT 'member';--> statement-breakpoint
ALTER TABLE "workspace_member" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "workspace_member" ALTER COLUMN "role" SET DATA TYPE "public"."workspace_role" USING (CASE WHEN "role"::text IN ('owner', 'admin') THEN 'admin' ELSE 'member' END)::"public"."workspace_role";--> statement-breakpoint
ALTER TABLE "workspace_member" ALTER COLUMN "role" SET DEFAULT 'member';--> statement-breakpoint
ALTER TABLE "board_member" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Materialize the "workspace admins are on every board" invariant: every workspace admin gets a
-- pinned editor row on every board in their workspace. Pinned rows are non-removable/non-downgradable
-- while the user stays an admin. Existing rows for admins are normalized to a pinned editor row.
INSERT INTO "board_member" ("board_id", "user_id", "role", "pinned")
SELECT b."id", wm."user_id", 'editor'::"public"."board_role", true
FROM "board" b
JOIN "workspace_member" wm ON wm."workspace_id" = b."workspace_id" AND wm."role" = 'admin'
ON CONFLICT ("board_id", "user_id") DO UPDATE SET "role" = 'editor', "pinned" = true;
