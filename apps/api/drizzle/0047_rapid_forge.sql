-- Catch up any writes made by the legacy release after the expand migration. Additional
-- memberships remain untouched because only the home pair has legacy user columns.
INSERT INTO client_member (client_id, user_id, client_role, added_at, suspended_at, removed_at)
SELECT client_id, id, client_role, created_at, suspended_at, removed_at FROM "user"
ON CONFLICT (client_id, user_id) DO UPDATE SET
  client_role = excluded.client_role,
  suspended_at = excluded.suspended_at,
  removed_at = excluded.removed_at;--> statement-breakpoint
-- Contract preflight. Abort before dropping legacy columns if any expand-phase reconciliation is
-- incomplete. Drizzle applies all pending migrations in one transaction, so a failure rolls back
-- both 0046 and 0047 and leaves the populated legacy schema intact.
DO $$
DECLARE
  membership_mismatches bigint;
  missing_notification_orgs bigint;
  missing_oauth_orgs bigint;
  unrestorable_plan_suspensions bigint;
BEGIN
  SELECT count(*) INTO membership_mismatches
  FROM (
    -- Every legacy home-organisation row must have been reconciled. Additional memberships are
    -- expected by this point and deliberately have no representation in the legacy user columns.
    SELECT u.client_id, u.id AS user_id
    FROM "user" u
    LEFT JOIN client_member cm
      ON cm.client_id = u.client_id AND cm.user_id = u.id
    WHERE cm.user_id IS NULL
       OR u.client_role IS DISTINCT FROM cm.client_role
       OR u.suspended_at IS DISTINCT FROM cm.suspended_at
       OR u.removed_at IS DISTINCT FROM cm.removed_at
  ) mismatch;
  IF membership_mismatches <> 0 THEN
    RAISE EXCEPTION 'client_member reconciliation failed: % mismatched legacy rows', membership_mismatches;
  END IF;

  SELECT count(*) INTO missing_notification_orgs
  FROM notification n
  JOIN workspace w ON w.id = n.workspace_id
  WHERE n.client_id IS DISTINCT FROM w.client_id;
  IF missing_notification_orgs <> 0 THEN
    RAISE EXCEPTION 'notification client_id reconciliation failed: % rows do not match their workspace', missing_notification_orgs;
  END IF;

  SELECT count(*) INTO missing_oauth_orgs
  FROM oauth_grant og
  JOIN "user" u ON u.id = og.user_id
  WHERE og.org_client_id IS DISTINCT FROM u.client_id;
  IF missing_oauth_orgs <> 0 THEN
    RAISE EXCEPTION 'oauth_grant org_client_id reconciliation failed: % rows do not match their legacy user organisation', missing_oauth_orgs;
  END IF;

  SELECT count(*) INTO unrestorable_plan_suspensions
  FROM plan_action pa
  WHERE pa.kind = 'user_suspended'
    AND NOT EXISTS (
      SELECT 1 FROM client_member cm
      WHERE cm.client_id = pa.client_id
        AND cm.user_id = (pa.payload->>'userId')::uuid
        AND cm.suspended_at IS NOT NULL
        AND cm.removed_at IS NULL
    );
  IF unrestorable_plan_suspensions <> 0 THEN
    RAISE EXCEPTION 'plan suspension reconciliation failed: % actions are not represented in client_member', unrestorable_plan_suspensions;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "user" DROP CONSTRAINT "users_client_role_ck";--> statement-breakpoint
ALTER TABLE "workspace_api_key" DROP CONSTRAINT "workspace_api_keys_kind_shape";--> statement-breakpoint
DROP INDEX "users_client_id_client_role_idx";--> statement-breakpoint
ALTER TABLE "notification" ALTER COLUMN "client_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_grant" ALTER COLUMN "org_client_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "client_role";--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "suspended_at";--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "removed_at";--> statement-breakpoint
ALTER TABLE "workspace_api_key" ADD CONSTRAINT "workspace_api_keys_kind_shape" CHECK (("workspace_api_key"."kind" = 'workspace' and "workspace_api_key"."workspace_id" is not null and "workspace_api_key"."name" is not null)
        or ("workspace_api_key"."kind" = 'personal' and "workspace_api_key"."workspace_id" is null and "workspace_api_key"."client_id" is not null));
