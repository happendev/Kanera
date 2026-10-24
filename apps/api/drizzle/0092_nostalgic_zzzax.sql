CREATE TABLE "automation_start_date_run" (
	"automation_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"start_date_local_date" text NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_start_date_run_automation_id_card_id_pk" PRIMARY KEY("automation_id","card_id")
);
--> statement-breakpoint
DROP VIEW "public"."card_summary_view";--> statement-breakpoint
ALTER TABLE "automation" DROP CONSTRAINT "automations_trigger_type_ck";--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN "start_date_local_date" date;--> statement-breakpoint
ALTER TABLE "automation_start_date_run" ADD CONSTRAINT "automation_start_date_run_automation_id_automation_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_start_date_run" ADD CONSTRAINT "automation_start_date_run_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_start_date_runs_card_id_idx" ON "automation_start_date_run" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "cards_active_incomplete_start_date_idx" ON "card" USING btree ("start_date_local_date","id") WHERE "card"."start_date_local_date" is not null and "card"."completed_at" is null and "card"."archived_at" is null;--> statement-breakpoint
ALTER TABLE "automation" ADD CONSTRAINT "automations_trigger_type_ck" CHECK ("automation"."trigger_type" in ('card_enters_list', 'card_leaves_list', 'due_date_arrives', 'due_date_approaching', 'start_date_arrives', 'card_becomes_inactive', 'card_in_progress_too_long', 'all_checklist_items_complete', 'card_assigned_to_user', 'card_marked_complete', 'card_label_set', 'custom_field_value_changed', 'card_unblocked', 'card_blocked'));--> statement-breakpoint
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
    c.start_date_local_date,
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
    coalesce(blocker_counts.blocked_by_count, 0)::integer as blocked_by_count,
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
    -- Open blockers only, including ones on boards the viewer cannot open: the count reveals no
    -- titles, and tiles must show "Blocked" either way. Keep in step with lib/card-relations.ts.
    select count(*)::integer as blocked_by_count
    from card_relation cr
    inner join card blocker on blocker.id = cr.source_card_id
    where cr.target_card_id = c.id
      and cr.kind = 'blocks'
      and blocker.completed_at is null
      and blocker.archived_at is null
  ) blocker_counts on true
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
--> statement-breakpoint
CREATE TABLE "board_schedule_state" (
	"board_id" uuid PRIMARY KEY NOT NULL,
	"projected_finish" text,
	"latest_due" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_schedule_state" (
	"card_id" uuid PRIMARY KEY NOT NULL,
	"conflict_blocker_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"critical" boolean DEFAULT false NOT NULL,
	"planned_end" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_recheck_queue" (
	"board_id" uuid PRIMARY KEY NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation" DROP CONSTRAINT "automations_trigger_type_ck";--> statement-breakpoint
ALTER TABLE "board_schedule_state" ADD CONSTRAINT "board_schedule_state_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_schedule_state" ADD CONSTRAINT "card_schedule_state_card_id_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_recheck_queue" ADD CONSTRAINT "schedule_recheck_queue_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation" ADD CONSTRAINT "automations_trigger_type_ck" CHECK ("automation"."trigger_type" in ('card_enters_list', 'card_leaves_list', 'due_date_arrives', 'due_date_approaching', 'start_date_arrives', 'card_becomes_inactive', 'card_in_progress_too_long', 'all_checklist_items_complete', 'card_assigned_to_user', 'card_marked_complete', 'card_label_set', 'custom_field_value_changed', 'card_unblocked', 'card_blocked', 'scheduling_conflict_appears', 'critical_path_slips'));
--> statement-breakpoint
-- Repair any ranges written by concurrent edits before the invariant was enforced.
UPDATE "card" SET "start_date_local_date" = "due_date_local_date"
WHERE "start_date_local_date" > "due_date_local_date";
--> statement-breakpoint
ALTER TABLE "card" ADD CONSTRAINT "cards_start_before_due_ck" CHECK ("card"."start_date_local_date" is null or "card"."due_date_local_date" is null or "card"."start_date_local_date" <= "card"."due_date_local_date");
--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "dependencies_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "timeline_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "dependencies_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "timeline_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "in_progress_enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
-- Time in progress gains a workspace switch between the organisation and the board: every gate that
-- read board AND organisation now reads all three. Workspace changes stamp each board's resume time
-- exactly as organisation changes do, so board_reconcile_in_progress banks or restarts the clocks.
CREATE OR REPLACE FUNCTION card_track_in_progress() RETURNS trigger AS $$
DECLARE
  flagged boolean;
  zone text;
  enabled boolean;
  resumed_at timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.list_entered_at := least(coalesce(NEW.list_entered_at, NEW.created_at, now()), now());
    NEW.in_progress_seconds := greatest(coalesce(NEW.in_progress_seconds, 0), 0);
  ELSE
    NEW.list_entered_at := CASE WHEN NEW.list_id IS DISTINCT FROM OLD.list_id THEN now() ELSE OLD.list_entered_at END;
    NEW.in_progress_since := OLD.in_progress_since;
    NEW.in_progress_seconds := OLD.in_progress_seconds;
    IF NEW.list_id IS NOT DISTINCT FROM OLD.list_id
      AND NEW.board_id IS NOT DISTINCT FROM OLD.board_id
      AND NEW.completed_at IS NOT DISTINCT FROM OLD.completed_at
      AND NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.list_id IS DISTINCT FROM OLD.list_id THEN
    SELECT l.in_progress INTO flagged FROM list l WHERE l.id = NEW.list_id FOR SHARE;
  ELSE
    SELECT l.in_progress INTO flagged FROM list l WHERE l.id = NEW.list_id;
  END IF;
  -- Ownership follows the card's board, including transfers and integration writes.
  IF TG_OP = 'INSERT' OR NEW.board_id IS DISTINCT FROM OLD.board_id THEN
    -- Take the board lock separately: a joined organisation row read before waiting can be stale.
    PERFORM 1 FROM board WHERE id = NEW.board_id FOR SHARE;
  END IF;
  SELECT b.in_progress_enabled AND w.in_progress_enabled AND o.in_progress_enabled, b.in_progress_resumed_at
    INTO enabled, resumed_at FROM board b JOIN workspace w ON w.id = b.workspace_id
    JOIN client o ON o.id = w.client_id WHERE b.id = NEW.board_id;
  IF coalesce(enabled, false) AND coalesce(flagged, false) AND NEW.completed_at IS NULL AND NEW.archived_at IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      NEW.in_progress_since := greatest(least(coalesce(NEW.in_progress_since, NEW.list_entered_at), now()), resumed_at);
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
CREATE OR REPLACE FUNCTION list_backfill_in_progress() RETURNS trigger AS $$
DECLARE
  zone text;
BEGIN
  IF NEW.in_progress IS NOT DISTINCT FROM OLD.in_progress THEN
    RETURN NEW;
  END IF;
  IF NEW.in_progress THEN
    -- Lists are workspace-wide. Serialize backfills with each board's gate before taking a fresh
    -- snapshot of its organisation; disabled boards must never regain a clock from a list edit.
    PERFORM 1 FROM board WHERE workspace_id = NEW.workspace_id ORDER BY id FOR SHARE;
    UPDATE card c SET in_progress_since = greatest(c.list_entered_at, b.in_progress_resumed_at)
    FROM board b JOIN workspace w ON w.id = b.workspace_id JOIN client o ON o.id = w.client_id
    WHERE c.board_id = b.id AND b.in_progress_enabled AND w.in_progress_enabled AND o.in_progress_enabled
      AND c.list_id = NEW.id AND c.completed_at IS NULL AND c.archived_at IS NULL AND c.in_progress_since IS NULL;
  ELSE
    SELECT w.time_zone INTO zone FROM workspace w WHERE w.id = NEW.workspace_id;
    UPDATE card
    SET in_progress_seconds = in_progress_seconds
          + in_progress_working_seconds(in_progress_since, now(), coalesce(zone, 'UTC')),
        in_progress_since = NULL
    WHERE list_id = NEW.id AND in_progress_since IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION board_reconcile_in_progress() RETURNS trigger AS $$
DECLARE enabled boolean; zone text;
BEGIN
  SELECT o.in_progress_enabled AND w.in_progress_enabled AND NEW.in_progress_enabled, w.time_zone INTO enabled, zone
    FROM workspace w JOIN client o ON o.id = w.client_id WHERE w.id = NEW.workspace_id;
  IF enabled THEN
    UPDATE card c SET in_progress_since = now()
    FROM list l WHERE c.board_id = NEW.id AND l.id = c.list_id AND l.in_progress
      AND c.completed_at IS NULL AND c.archived_at IS NULL AND c.in_progress_since IS NULL;
  ELSE
    UPDATE card SET in_progress_seconds = in_progress_seconds
      + in_progress_working_seconds(in_progress_since, now(), zone), in_progress_since = NULL
    WHERE board_id = NEW.id AND in_progress_since IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE FUNCTION workspace_reconcile_in_progress() RETURNS trigger AS $$
BEGIN
  IF NEW.in_progress_enabled IS DISTINCT FROM OLD.in_progress_enabled THEN
    UPDATE board SET in_progress_resumed_at = now() WHERE workspace_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER workspace_reconcile_in_progress AFTER UPDATE OF in_progress_enabled ON workspace
FOR EACH ROW EXECUTE FUNCTION workspace_reconcile_in_progress();
