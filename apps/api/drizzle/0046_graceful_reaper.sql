CREATE TABLE "client_member" (
	"client_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"client_role" text DEFAULT 'member' NOT NULL,
	"suspended_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_by_id" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_member_client_id_user_id_pk" PRIMARY KEY("client_id","user_id"),
	CONSTRAINT "client_members_client_role_ck" CHECK ("client_member"."client_role" in ('owner', 'admin', 'member'))
);
--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_grant" ADD COLUMN "org_client_id" uuid;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "active_client_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_api_key" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "client_member" ADD CONSTRAINT "client_member_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_member" ADD CONSTRAINT "client_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_member" ADD CONSTRAINT "client_member_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_members_user_id_idx" ON "client_member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "client_members_active_idx" ON "client_member" USING btree ("client_id","client_role") WHERE "client_member"."suspended_at" is null and "client_member"."removed_at" is null;--> statement-breakpoint
-- Expand-phase backfill: application reads remain on the legacy user columns in this release.
-- Removed-user tombstones intentionally remain inactive memberships. Historical rewritten email
-- addresses cannot be recovered safely and are left unchanged.
INSERT INTO "client_member" ("client_id", "user_id", "client_role", "added_at", "suspended_at", "removed_at")
SELECT "client_id", "id", "client_role", "created_at", "suspended_at", "removed_at"
FROM "user"
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "user"
SET "active_client_id" = "client_id"
WHERE "active_client_id" IS NULL;--> statement-breakpoint
-- 0046 and 0047 are applied by Drizzle in one transaction. Backfill every legacy row here so the
-- following contract migration can validate and make the organisation key required atomically.
UPDATE "notification" notification_row
SET "client_id" = workspace_row."client_id"
FROM "workspace" workspace_row
WHERE workspace_row."id" = notification_row."workspace_id"
	AND notification_row."client_id" IS DISTINCT FROM workspace_row."client_id";--> statement-breakpoint
-- Under the legacy one-organisation-per-user model a user could own at most one client. That
-- invariant is what makes 0047's partial unique index on created_by_user_id safe after this pick.
UPDATE "client" c
SET "created_by_user_id" = owner_row."id"
FROM (
	SELECT DISTINCT ON ("client_id") "client_id", "id"
	FROM "user"
	WHERE "client_role" = 'owner'
	ORDER BY "client_id", "created_at" ASC
) owner_row
WHERE owner_row."client_id" = c."id"
	AND c."created_by_user_id" IS NULL;--> statement-breakpoint
UPDATE "workspace_api_key" key_row
SET "client_id" = creator."client_id"
FROM "user" creator
WHERE creator."id" = key_row."created_by_id"
	AND key_row."client_id" IS NULL;--> statement-breakpoint
UPDATE "oauth_grant" grant_row
SET "org_client_id" = grant_user."client_id"
FROM "user" grant_user
WHERE grant_user."id" = grant_row."user_id"
	AND grant_row."org_client_id" IS DISTINCT FROM grant_user."client_id";--> statement-breakpoint
-- Build constraints and indexes after the bulk updates. This avoids maintaining two new
-- notification indexes row-by-row and gives populated installations one validation pass over each
-- backfilled relation.
ALTER TABLE "client" ADD CONSTRAINT "client_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grant" ADD CONSTRAINT "oauth_grant_org_client_id_client_id_fk" FOREIGN KEY ("org_client_id") REFERENCES "public"."client"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_active_client_id_client_id_fk" FOREIGN KEY ("active_client_id") REFERENCES "public"."client"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_api_key" ADD CONSTRAINT "workspace_api_key_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_user_client_created_idx" ON "notification" USING btree ("user_id","client_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_client_unread_idx" ON "notification" USING btree ("user_id","client_id","created_at") WHERE "notification"."read_at" is null;
