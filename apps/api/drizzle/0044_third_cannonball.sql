CREATE TABLE IF NOT EXISTS "card_key_prefix_reservation" (
	"client_id" uuid,
	"prefix" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_key_prefix_reservations_prefix_ck" CHECK ("card_key_prefix_reservation"."prefix" ~ '^[A-Z][A-Z0-9]{1,9}$')
);
--> statement-breakpoint
ALTER TABLE "card_key_prefix_reservation" ADD COLUMN IF NOT EXISTS "client_id" uuid;--> statement-breakpoint
UPDATE "card_key_prefix_reservation" r
SET "client_id" = w."client_id"
FROM "workspace" w
WHERE r."workspace_id" = w."id" AND r."client_id" IS NULL;--> statement-breakpoint
-- The provisional, unshipped global-prefix migration did not retain an organisation id for
-- tombstones after workspace deletion. There is no safe tenant to assign those rows to.
DELETE FROM "card_key_prefix_reservation" WHERE "client_id" IS NULL;--> statement-breakpoint
DO $$
DECLARE
  primary_key_name text;
BEGIN
  SELECT conname INTO primary_key_name
  FROM pg_constraint
  WHERE conrelid = 'card_key_prefix_reservation'::regclass AND contype = 'p';
  IF primary_key_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE card_key_prefix_reservation DROP CONSTRAINT %I', primary_key_name);
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "card_key_prefix_reservation" ALTER COLUMN "client_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "card_key_prefix_reservation" ADD CONSTRAINT "card_key_prefix_reservation_client_id_prefix_pk" PRIMARY KEY("client_id","prefix");--> statement-breakpoint
DROP VIEW "public"."card_summary_view";--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN IF NOT EXISTS "workspace_id" uuid DEFAULT null;--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN IF NOT EXISTS "organisation_key" text DEFAULT null;--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN IF NOT EXISTS "number" integer DEFAULT null;--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN IF NOT EXISTS "key" text DEFAULT null;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN IF NOT EXISTS "route_key" text DEFAULT upper(substr(md5(random()::text || clock_timestamp()::text || uuidv7()::text), 1, 16)) NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN IF NOT EXISTS "card_key_prefix" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN IF NOT EXISTS "last_card_number" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$
DECLARE
  ws record;
  base text;
  candidate text;
  suffix text;
  collision_index integer;
  reserved_count integer;
  owner_id uuid;
BEGIN
  -- Prefix contention is organisation-local. Stable ordering makes cloned database backfills
  -- deterministic while allowing every organisation to start with the same natural prefix. Keep
  -- assignments from the provisional global-prefix migration when upgrading a local database.
  FOR ws IN SELECT id, client_id, name, card_key_prefix FROM workspace ORDER BY client_id, created_at, id LOOP
    candidate := upper(ws.card_key_prefix);
    IF candidate ~ '^[A-Z][A-Z0-9]{1,9}$' THEN
      SELECT workspace_id INTO owner_id FROM card_key_prefix_reservation
      WHERE client_id = ws.client_id AND prefix = candidate;
      IF owner_id IS NULL THEN
        INSERT INTO card_key_prefix_reservation(client_id, prefix, workspace_id)
        VALUES (ws.client_id, candidate, ws.id);
        owner_id := ws.id;
      END IF;
      IF owner_id = ws.id THEN
        CONTINUE;
      END IF;
    END IF;

    base := regexp_replace(upper(ws.name), '[^A-Z0-9]', '', 'g');
    base := regexp_replace(base, '^[^A-Z]+', '');
    IF length(base) = 0 THEN base := 'WS';
    ELSIF length(base) = 1 THEN base := base || 'X';
    ELSE base := left(base, 10);
    END IF;

    collision_index := 0;
    LOOP
      IF collision_index = 0 THEN candidate := left(base, 10);
      ELSE
        suffix := (collision_index + 1)::text;
        candidate := left(base, greatest(1, 10 - length(suffix))) || suffix;
      END IF;
      INSERT INTO card_key_prefix_reservation(client_id, prefix, workspace_id)
      VALUES (ws.client_id, candidate, ws.id)
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS reserved_count = ROW_COUNT;
      EXIT WHEN reserved_count = 1;
      collision_index := collision_index + 1;
    END LOOP;
    UPDATE workspace SET card_key_prefix = candidate WHERE id = ws.id;
  END LOOP;
END $$;--> statement-breakpoint
WITH numbered AS (
  SELECT c.id, b.workspace_id, cl.route_key AS organisation_key, row_number() OVER (
    PARTITION BY b.workspace_id ORDER BY c.created_at, c.id
  )::integer AS card_number
  FROM card c
  INNER JOIN board b ON b.id = c.board_id
  INNER JOIN workspace w ON w.id = b.workspace_id
  INNER JOIN client cl ON cl.id = w.client_id
)
UPDATE card c
SET workspace_id = numbered.workspace_id,
    organisation_key = numbered.organisation_key,
    number = numbered.card_number,
    key = w.card_key_prefix || '-' || numbered.card_number::text
FROM numbered
INNER JOIN workspace w ON w.id = numbered.workspace_id
WHERE c.id = numbered.id;--> statement-breakpoint
UPDATE workspace w
SET last_card_number = coalesce((SELECT max(c.number) FROM card c WHERE c.workspace_id = w.id), 0);--> statement-breakpoint
ALTER TABLE "card" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "card" ALTER COLUMN "organisation_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "card" ALTER COLUMN "number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "card" ALTER COLUMN "key" SET NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "card_key_prefix_reservations_workspace_id_idx" ON "card_key_prefix_reservation" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "card" DROP CONSTRAINT IF EXISTS "card_workspace_id_workspace_id_fk";--> statement-breakpoint
ALTER TABLE "card" ADD CONSTRAINT "card_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "clients_route_key_key" ON "client" USING btree ("route_key");--> statement-breakpoint
ALTER TABLE "card" DROP CONSTRAINT IF EXISTS "card_organisation_key_client_route_key_fk";--> statement-breakpoint
ALTER TABLE "card" ADD CONSTRAINT "card_organisation_key_client_route_key_fk" FOREIGN KEY ("organisation_key") REFERENCES "public"."client"("route_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "boards_workspace_id_id_key" ON "board" USING btree ("workspace_id","id");--> statement-breakpoint
ALTER TABLE "card" DROP CONSTRAINT IF EXISTS "cards_workspace_board_fk";--> statement-breakpoint
ALTER TABLE "card" ADD CONSTRAINT "cards_workspace_board_fk" FOREIGN KEY ("workspace_id","board_id") REFERENCES "public"."board"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cards_workspace_id_number_key" ON "card" USING btree ("workspace_id","number");--> statement-breakpoint
DROP INDEX IF EXISTS "cards_key_key";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cards_organisation_key_key_key" ON "card" USING btree ("organisation_key","key");--> statement-breakpoint
DROP INDEX IF EXISTS "workspaces_card_key_prefix_key";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_client_id_card_key_prefix_key" ON "workspace" USING btree ("client_id","card_key_prefix");--> statement-breakpoint
ALTER TABLE "card" DROP CONSTRAINT IF EXISTS "cards_number_ck";--> statement-breakpoint
ALTER TABLE "card" ADD CONSTRAINT "cards_number_ck" CHECK ("card"."number" > 0);--> statement-breakpoint
ALTER TABLE "card" DROP CONSTRAINT IF EXISTS "cards_key_ck";--> statement-breakpoint
ALTER TABLE "card" ADD CONSTRAINT "cards_key_ck" CHECK ("card"."key" ~ '^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*$');--> statement-breakpoint
ALTER TABLE "client" DROP CONSTRAINT IF EXISTS "clients_route_key_ck";--> statement-breakpoint
ALTER TABLE "client" ADD CONSTRAINT "clients_route_key_ck" CHECK ("client"."route_key" ~ '^[A-F0-9]{16}$');--> statement-breakpoint
ALTER TABLE "workspace" DROP CONSTRAINT IF EXISTS "workspaces_card_key_prefix_ck";--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspaces_card_key_prefix_ck" CHECK ("workspace"."card_key_prefix" ~ '^[A-Z][A-Z0-9]{1,9}$');--> statement-breakpoint
ALTER TABLE "workspace" DROP CONSTRAINT IF EXISTS "workspaces_last_card_number_ck";--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspaces_last_card_number_ck" CHECK ("workspace"."last_card_number" >= 0);--> statement-breakpoint
CREATE OR REPLACE FUNCTION reserve_workspace_card_key_prefix() RETURNS trigger AS $$
DECLARE
  base text;
  candidate text;
  suffix text;
  collision_index integer := 0;
  owner_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.card_key_prefix = OLD.card_key_prefix THEN RETURN NEW; END IF;
  IF NEW.card_key_prefix IS NULL OR NEW.card_key_prefix = '' THEN
    base := regexp_replace(upper(NEW.name), '[^A-Z0-9]', '', 'g');
    base := regexp_replace(base, '^[^A-Z]+', '');
    IF length(base) = 0 THEN base := 'WS';
    ELSIF length(base) = 1 THEN base := base || 'X';
    ELSE base := left(base, 10);
    END IF;
    LOOP
      IF collision_index = 0 THEN candidate := left(base, 10);
      ELSE
        suffix := (collision_index + 1)::text;
        candidate := left(base, greatest(1, 10 - length(suffix))) || suffix;
      END IF;
      SELECT workspace_id INTO owner_id FROM card_key_prefix_reservation
      WHERE client_id = NEW.client_id AND prefix = candidate;
      EXIT WHEN owner_id IS NULL;
      collision_index := collision_index + 1;
    END LOOP;
    NEW.card_key_prefix := candidate;
  ELSE
    NEW.card_key_prefix := upper(NEW.card_key_prefix);
  END IF;

  SELECT workspace_id INTO owner_id FROM card_key_prefix_reservation
  WHERE client_id = NEW.client_id AND prefix = NEW.card_key_prefix;
  IF owner_id IS NOT NULL AND owner_id <> NEW.id THEN
    RAISE EXCEPTION 'card key prefix % is already reserved in this organisation', NEW.card_key_prefix USING ERRCODE = '23505';
  END IF;
  INSERT INTO card_key_prefix_reservation(client_id, prefix, workspace_id)
  VALUES (NEW.client_id, NEW.card_key_prefix, NEW.id)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS workspace_reserve_card_key_prefix ON workspace;--> statement-breakpoint
CREATE TRIGGER workspace_reserve_card_key_prefix
BEFORE INSERT OR UPDATE OF card_key_prefix ON workspace
FOR EACH ROW EXECUTE FUNCTION reserve_workspace_card_key_prefix();--> statement-breakpoint
CREATE OR REPLACE FUNCTION rewrite_workspace_card_keys() RETURNS trigger AS $$
BEGIN
  IF NEW.card_key_prefix IS DISTINCT FROM OLD.card_key_prefix THEN
    UPDATE card SET key = NEW.card_key_prefix || '-' || number::text
    WHERE workspace_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS workspace_rewrite_card_keys ON workspace;--> statement-breakpoint
CREATE TRIGGER workspace_rewrite_card_keys
AFTER UPDATE OF card_key_prefix ON workspace
FOR EACH ROW EXECUTE FUNCTION rewrite_workspace_card_keys();--> statement-breakpoint
CREATE OR REPLACE FUNCTION allocate_card_identity_on_insert() RETURNS trigger AS $$
DECLARE
  board_workspace_id uuid;
  route_key text;
  prefix text;
BEGIN
  SELECT b.workspace_id, cl.route_key, w.card_key_prefix INTO board_workspace_id, route_key, prefix
  FROM board b
  INNER JOIN workspace w ON w.id = b.workspace_id
  INNER JOIN client cl ON cl.id = w.client_id
  WHERE b.id = NEW.board_id;
  IF board_workspace_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.workspace_id IS NOT NULL AND NEW.workspace_id <> board_workspace_id THEN
    RAISE EXCEPTION 'card workspace does not match board workspace' USING ERRCODE = '23503';
  END IF;
  IF NEW.organisation_key IS NOT NULL AND NEW.organisation_key <> route_key THEN
    RAISE EXCEPTION 'card organisation does not match board organisation' USING ERRCODE = '23503';
  END IF;
  NEW.workspace_id := board_workspace_id;
  NEW.organisation_key := route_key;
  IF NEW.number IS NULL OR NEW.key IS NULL THEN
    UPDATE workspace SET last_card_number = last_card_number + 1
    WHERE id = board_workspace_id RETURNING last_card_number, card_key_prefix INTO NEW.number, prefix;
    NEW.key := prefix || '-' || NEW.number::text;
  ELSE
    IF NEW.number <= 0 OR NEW.key <> prefix || '-' || NEW.number::text THEN
      RAISE EXCEPTION 'invalid card identity for workspace' USING ERRCODE = '23514';
    END IF;
    UPDATE workspace SET last_card_number = greatest(last_card_number, NEW.number)
    WHERE id = board_workspace_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS card_allocate_identity ON card;--> statement-breakpoint
CREATE TRIGGER card_allocate_identity
BEFORE INSERT ON card
FOR EACH ROW EXECUTE FUNCTION allocate_card_identity_on_insert();--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_client_route_key_update() RETURNS trigger AS $$
BEGIN
  IF NEW.route_key IS DISTINCT FROM OLD.route_key THEN
    RAISE EXCEPTION 'organisation route key is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS client_route_key_immutable ON client;--> statement-breakpoint
CREATE TRIGGER client_route_key_immutable
BEFORE UPDATE OF route_key ON client
FOR EACH ROW EXECUTE FUNCTION prevent_client_route_key_update();--> statement-breakpoint
CREATE VIEW "public"."card_summary_view" AS (
  select
    c.id,
    c.workspace_id,
    c.organisation_key,
    c.number,
    c.key,
    c.list_id,
    c.board_id,
    c.title,
    c.position,
    c.due_date_local_date,
    c.due_date_slot,
    c.due_date_timezone,
    c.completed_at,
    c.archived_at,
    c.cover_attachment_id,
    c.created_at,
    c.updated_at,
    c.description is not null as has_description,
    coalesce(comment_counts.comment_count, 0)::integer as comment_count,
    coalesce(attachment_counts.attachment_count, 0)::integer as attachment_count,
    coalesce(checklist_counts.done_count, 0)::integer as checklist_done_count,
    coalesce(checklist_counts.total_count, 0)::integer as checklist_total_count,
    coalesce(label_ids.label_ids, '{}'::uuid[]) as label_ids,
    coalesce(assignee_ids.assignee_ids, '{}'::uuid[]) as assignee_ids,
    coalesce(custom_field_values.custom_field_values, '[]'::json) as custom_field_values,
    cover.file_key as cover_file_key,
    cover.url as cover_url,
    cover.thumbnail_file_key as cover_thumbnail_file_key,
    cover.thumbnail_url as cover_thumbnail_url,
    cover.cover_image_file_key,
    cover.cover_image_url,
    cover.cover_image_width,
    cover.cover_image_height,
    cover.cover_image_color
  from card c
  left join card_attachment cover on cover.id = c.cover_attachment_id
  left join lateral (
    select count(*)::integer as comment_count
    from comment cm
    where cm.card_id = c.id
  ) comment_counts on true
  left join lateral (
    select count(*)::integer as attachment_count
    from card_attachment ca
    where ca.card_id = c.id
  ) attachment_counts on true
  left join lateral (
    select
      count(*)::integer as total_count,
      count(*) filter (where ci.completed_at is not null)::integer as done_count
    from card_checklist cl
    inner join card_checklist_item ci on ci.checklist_id = cl.id
    where cl.card_id = c.id
      and cl.parent_item_id is null
  ) checklist_counts on true
  left join lateral (
    select array_agg(cla.label_id order by cla.assigned_at, cla.label_id) as label_ids
    from card_label_assignment cla
    where cla.card_id = c.id
  ) label_ids on true
  left join lateral (
    select array_agg(ca.user_id order by ca.assigned_at, ca.user_id) as assignee_ids
    from card_assignee ca
    where ca.card_id = c.id
  ) assignee_ids on true
  left join lateral (
    select json_agg(
      json_build_object(
        'cardId', cfv.card_id,
        'fieldId', cfv.field_id,
        'valueText', cfv.value_text,
        'valueNumber', cfv.value_number::text,
        'valueCheckbox', cfv.value_checkbox,
        'valueDate', cfv.value_date,
        'valueUrl', cfv.value_url,
        'valueOptionIds', cfv.value_option_ids,
        'valueUserIds', cfv.value_user_ids,
        'updatedAt', cfv.updated_at
      )
      order by cfv.field_id
    ) as custom_field_values
    from card_custom_field_value cfv
    where cfv.card_id = c.id
  ) custom_field_values on true
);
