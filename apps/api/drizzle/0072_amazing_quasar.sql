DROP VIEW "public"."card_summary_view";--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN "in_progress_since" timestamp with time zone;--> statement-breakpoint
-- Added nullable, backfilled below, then made NOT NULL: the trigger owns it from then on.
ALTER TABLE "card" ADD COLUMN "list_entered_at" timestamp with time zone DEFAULT null;--> statement-breakpoint
ALTER TABLE "list" ADD COLUMN "in_progress" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN "in_progress_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "card" ADD CONSTRAINT "cards_in_progress_seconds_ck" CHECK ("card"."in_progress_seconds" >= 0);--> statement-breakpoint
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
    c.in_progress_since,
    c.in_progress_seconds,
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
);--> statement-breakpoint
-- When each existing card entered its current list: the last recorded move into that list, else
-- its creation (a card that was never moved has been here since it was created). One set-based
-- pass; from here on the trigger below keeps it exact on every list change, including paths that
-- record no per-card move activity.
UPDATE card c
SET list_entered_at = coalesce(entered.at, c.created_at)
FROM card c0
LEFT JOIN (
  SELECT a.entity_id AS card_id, a.payload->>'toListId' AS list_id, max(a.created_at) AS at
  FROM activity_event a
  WHERE a.entity_type = 'card'
    AND a.action = 'moved'
    AND a.feed_visible = true
  GROUP BY 1, 2
) entered ON entered.card_id = c0.id AND entered.list_id = c0.list_id::text
WHERE c0.id = c.id;--> statement-breakpoint
ALTER TABLE "card" ALTER COLUMN "list_entered_at" SET NOT NULL;--> statement-breakpoint
-- WIP limits, the time-in-progress alert and its card_in_progress_too_long automation ledger.
CREATE TABLE "automation_in_progress_run" (
	"automation_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"alert_at" timestamp with time zone NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_in_progress_run_automation_id_card_id_pk" PRIMARY KEY("automation_id","card_id")
);
--> statement-breakpoint
ALTER TABLE "automation" DROP CONSTRAINT "automations_trigger_type_ck";--> statement-breakpoint
ALTER TABLE "list" ADD COLUMN "wip_limit" integer;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "in_progress_alert_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_in_progress_run" ADD CONSTRAINT "automation_in_progress_run_automation_id_automation_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_in_progress_run" ADD CONSTRAINT "automation_in_progress_run_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_in_progress_runs_card_id_idx" ON "automation_in_progress_run" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "cards_in_progress_since_idx" ON "card" USING btree ("in_progress_since") WHERE "card"."in_progress_since" is not null;--> statement-breakpoint
ALTER TABLE "automation" ADD CONSTRAINT "automations_trigger_type_ck" CHECK ("automation"."trigger_type" in ('card_enters_list', 'card_leaves_list', 'due_date_arrives', 'due_date_approaching', 'card_becomes_inactive', 'card_in_progress_too_long', 'all_checklist_items_complete', 'card_assigned_to_user', 'card_marked_complete', 'card_label_set', 'custom_field_value_changed'));--> statement-breakpoint
ALTER TABLE "list" ADD CONSTRAINT "lists_wip_limit_ck" CHECK ("list"."wip_limit" is null or ("list"."wip_limit" between 1 and 999));--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "time_zone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
-- Existing workspaces take their organisation owner's time zone (the earliest active owner), the
-- closest thing to a team zone that exists today; admins can change it in General settings.
UPDATE workspace w
SET time_zone = owner_zone.timezone
FROM (
  SELECT DISTINCT ON (cm.client_id) cm.client_id, u.timezone
  FROM client_member cm
  INNER JOIN "user" u ON u.id = cm.user_id
  WHERE cm.client_role = 'owner' AND cm.removed_at IS NULL AND cm.suspended_at IS NULL
  ORDER BY cm.client_id, cm.added_at, cm.user_id
) owner_zone
WHERE owner_zone.client_id = w.client_id
  AND owner_zone.timezone IS NOT NULL
  AND owner_zone.timezone <> '';--> statement-breakpoint
-- Tracked time is working time: 09:00-17:00, Monday to Friday, in the workspace's time zone. That
-- caps a day at 8 hours, skips weekends and nights, and needs no state across stints because stints
-- never overlap. The SQL twin of `workingMs` in `@kanera/shared/time-in-progress`; keep them in
-- step. A zone Postgres does not know falls back to UTC rather than failing the card write.
CREATE OR REPLACE FUNCTION in_progress_working_seconds(start timestamptz, stop timestamptz, tz text) RETURNS integer AS $$
DECLARE
  zone text := 'UTC';
  total double precision := 0;
  local_day date;
  last_day date;
  day_open timestamptz;
  day_close timestamptz;
BEGIN
  IF start IS NULL OR stop IS NULL OR stop <= start THEN
    RETURN 0;
  END IF;
  BEGIN
    PERFORM now() AT TIME ZONE tz;
    zone := tz;
  EXCEPTION WHEN others THEN
    zone := 'UTC';
  END;
  local_day := (start AT TIME ZONE zone)::date;
  last_day := (stop AT TIME ZONE zone)::date;
  WHILE local_day <= last_day LOOP
    -- isodow: 6 is Saturday, 7 Sunday.
    IF extract(isodow FROM local_day) < 6 THEN
      day_open := (local_day + time '09:00') AT TIME ZONE zone;
      day_close := (local_day + time '17:00') AT TIME ZONE zone;
      total := total + greatest(0, extract(epoch FROM least(day_close, stop) - greatest(day_open, start)));
    END IF;
    local_day := local_day + 1;
  END LOOP;
  RETURN floor(total)::integer;
END;
$$ LANGUAGE plpgsql STABLE;--> statement-breakpoint
-- The card trigger owns the clock for every write path: moves, completion and archiving bank
-- working time; reopening or unarchiving starts a new stint. Moving between in-progress lists
-- keeps the running start. Imports may restore an earlier start and banked total on insert.
-- The target list is read FOR SHARE so a concurrent flag change and card write serialize;
-- locking only the target avoids a source-list lock inversion with the list backfill.
CREATE OR REPLACE FUNCTION card_track_in_progress() RETURNS trigger AS $$
DECLARE
  flagged boolean;
  zone text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Imports restore the exported entry time and banked total; everything else enters at creation
    -- with nothing banked. Never future.
    NEW.list_entered_at := least(coalesce(NEW.list_entered_at, NEW.created_at, now()), now());
    NEW.in_progress_seconds := greatest(coalesce(NEW.in_progress_seconds, 0), 0);
  ELSE
    NEW.list_entered_at := CASE WHEN NEW.list_id IS DISTINCT FROM OLD.list_id THEN now() ELSE OLD.list_entered_at END;
    NEW.in_progress_since := OLD.in_progress_since;
    NEW.in_progress_seconds := OLD.in_progress_seconds;
    IF NEW.list_id IS NOT DISTINCT FROM OLD.list_id
      AND NEW.completed_at IS NOT DISTINCT FROM OLD.completed_at
      AND NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at THEN
      RETURN NEW;
    END IF;
  END IF;
  SELECT l.in_progress INTO flagged FROM list l WHERE l.id = NEW.list_id FOR SHARE;
  IF coalesce(flagged, false) AND NEW.completed_at IS NULL AND NEW.archived_at IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      NEW.in_progress_since := least(coalesce(NEW.in_progress_since, NEW.list_entered_at), now());
    ELSIF OLD.in_progress_since IS NULL THEN
      NEW.in_progress_since := now();
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.in_progress_since IS NOT NULL THEN
    SELECT w.time_zone INTO zone FROM workspace w WHERE w.id = OLD.workspace_id;
    NEW.in_progress_seconds := OLD.in_progress_seconds
      + in_progress_working_seconds(OLD.in_progress_since, now(), coalesce(zone, 'UTC'));
  END IF;
  NEW.in_progress_since := NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS card_track_in_progress ON card;--> statement-breakpoint
CREATE TRIGGER card_track_in_progress
BEFORE INSERT OR UPDATE OF list_id, completed_at, archived_at ON card
FOR EACH ROW EXECUTE FUNCTION card_track_in_progress();--> statement-breakpoint
-- Flagging or unflagging a list re-classifies the stay of the open cards already in it, so it is
-- retroactive in both directions and idempotent: flagging starts each open card's stint from when
-- it entered the list; unflagging discards those running stints rather than banking them, so an
-- accidental flag-and-unflag leaves every total exactly as it was. Stints already banked (by moves,
-- completion or archiving) are real history and are never touched. Completed and archived cards are
-- skipped: their stint starts when they are reopened or unarchived, via the card trigger. Neither
-- touches `updated_at`: re-classifying a list is not an edit to its cards.
CREATE OR REPLACE FUNCTION list_backfill_in_progress() RETURNS trigger AS $$
BEGIN
  IF NEW.in_progress IS NOT DISTINCT FROM OLD.in_progress THEN
    RETURN NEW;
  END IF;
  IF NEW.in_progress THEN
    UPDATE card SET in_progress_since = list_entered_at
    WHERE list_id = NEW.id AND completed_at IS NULL AND archived_at IS NULL AND in_progress_since IS NULL;
  ELSE
    UPDATE card SET in_progress_since = NULL
    WHERE list_id = NEW.id AND in_progress_since IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS list_backfill_in_progress ON list;--> statement-breakpoint
CREATE TRIGGER list_backfill_in_progress
AFTER UPDATE OF in_progress ON list
FOR EACH ROW EXECUTE FUNCTION list_backfill_in_progress();--> statement-breakpoint
-- Existing workspaces: flag the lists Kanera's own templates named as active work, so the signal
-- works on day one. Anything else is left for workspace admins to classify. The trigger above
-- starts each card's clock from `list_entered_at`.
UPDATE list SET in_progress = true
WHERE lower(btrim(name)) IN ('in progress', 'doing')
  AND in_progress = false;--> statement-breakpoint
-- The initial classification starts only open clocks. Existing completed/archived cards still
-- receive the historical credit they would have banked at the earlier of completion or archiving,
-- using their recovered list-entry timestamp; future or post-completion entries earn nothing.
UPDATE card c
SET in_progress_seconds = in_progress_working_seconds(
  c.list_entered_at, least(least(c.completed_at, c.archived_at), now()), w.time_zone)
FROM workspace w, list l
WHERE w.id = c.workspace_id
  AND l.id = c.list_id AND l.in_progress
  AND (c.completed_at IS NOT NULL OR c.archived_at IS NOT NULL);
