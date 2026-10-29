ALTER TABLE "card" ADD COLUMN "detail_revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
-- The counter belongs to the card, including its detail and feed rows. Keeping this invariant in
-- the database covers app/public API, worker automations, imports and FK cascades in the same
-- transaction as the data change. Event publication never increments it, and neither does a read
-- itself (a detail read's background link repair is an ordinary write). A bulk purge of history
-- that nobody is shown (retention, organisation deletion) opts out of the child-row bump for its
-- transaction with SET LOCAL kanera.skip_card_detail_revision = 'on'.
CREATE FUNCTION card_advance_detail_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.detail_revision := 1;
  ELSIF (to_jsonb(NEW) - 'search_vector') IS DISTINCT FROM (to_jsonb(OLD) - 'search_vector') THEN
    NEW.detail_revision := OLD.detail_revision + 1;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Run after other BEFORE-row triggers so their derived card fields are included in this revision.
CREATE TRIGGER zz_card_detail_revision BEFORE INSERT OR UPDATE ON card
FOR EACH ROW EXECUTE FUNCTION card_advance_detail_revision();
--> statement-breakpoint
CREATE FUNCTION card_detail_child_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rows_to_check jsonb[] := ARRAY[]::jsonb[];
  changed_row jsonb;
  owner_ids uuid[] := ARRAY[]::uuid[];
  owner_id uuid;
  activity_card_id text;
BEGIN
  IF current_setting('kanera.skip_card_detail_revision', true) = 'on' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD) THEN RETURN NULL; END IF;
  IF TG_OP <> 'INSERT' THEN rows_to_check := array_append(rows_to_check, to_jsonb(OLD)); END IF;
  IF TG_OP <> 'DELETE' THEN rows_to_check := array_append(rows_to_check, to_jsonb(NEW)); END IF;

  FOREACH changed_row IN ARRAY rows_to_check LOOP
    IF changed_row ? 'card_id' THEN
      owner_ids := array_append(owner_ids, (changed_row->>'card_id')::uuid);
    ELSIF TG_TABLE_NAME = 'card_checklist_item' THEN
      SELECT card_id INTO owner_id FROM card_checklist WHERE id = (changed_row->>'checklist_id')::uuid;
      owner_ids := array_append(owner_ids, owner_id);
    ELSIF TG_TABLE_NAME = 'comment_reaction' THEN
      SELECT card_id INTO owner_id FROM comment WHERE id = (changed_row->>'comment_id')::uuid;
      owner_ids := array_append(owner_ids, owner_id);
    ELSIF TG_TABLE_NAME = 'card_attachment_reaction' THEN
      SELECT card_id INTO owner_id FROM card_attachment WHERE id = (changed_row->>'attachment_id')::uuid;
      owner_ids := array_append(owner_ids, owner_id);
    ELSIF TG_TABLE_NAME = 'card_relation' THEN
      owner_ids := owner_ids || ARRAY[(changed_row->>'source_card_id')::uuid, (changed_row->>'target_card_id')::uuid];
    ELSIF TG_TABLE_NAME = 'internal_link' THEN
      IF changed_row->>'source_type' = 'card' THEN owner_ids := array_append(owner_ids, (changed_row->>'source_id')::uuid); END IF;
      IF changed_row->>'target_type' = 'card' THEN owner_ids := array_append(owner_ids, (changed_row->>'target_id')::uuid); END IF;
    ELSIF TG_TABLE_NAME = 'activity_event' THEN
      -- Match card-feed ownership, including hidden/coalesced/deleted rows and comment audit rows.
      -- Payloads are historical JSON; an unrelated non-UUID cardId must not break an audit write.
      IF changed_row->>'entity_type' = 'card' THEN owner_ids := array_append(owner_ids, (changed_row->>'entity_id')::uuid); END IF;
      activity_card_id := changed_row->'payload'->>'cardId';
      IF activity_card_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        owner_ids := array_append(owner_ids, activity_card_id::uuid);
      END IF;
    END IF;
  END LOOP;

  -- Moving a row can affect both cards. Stable order avoids inverse locking for that pair.
  -- Cascades may already have removed a parent; its own delete trigger covers the remaining card.
  FOR owner_id IN SELECT DISTINCT id FROM unnest(owner_ids) AS ids(id) WHERE id IS NOT NULL ORDER BY id LOOP
    UPDATE card SET detail_revision = detail_revision + 1 WHERE id = owner_id;
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DO $$
DECLARE detail_table text;
BEGIN
  FOREACH detail_table IN ARRAY ARRAY[
    'card_checklist', 'card_checklist_item', 'card_checklist_template_application',
    'card_attachment', 'card_attachment_reaction', 'card_custom_field_value',
    'card_label_assignment', 'card_assignee', 'comment', 'comment_reaction',
    'card_relation', 'internal_link', 'activity_event'
  ] LOOP
    EXECUTE format('CREATE TRIGGER card_detail_changed AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION card_detail_child_changed()', detail_table);
  END LOOP;
END;
$$;
