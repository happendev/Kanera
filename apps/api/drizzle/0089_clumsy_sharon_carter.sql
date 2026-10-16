ALTER TABLE "board" ADD COLUMN "in_progress_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "board" ADD COLUMN "in_progress_resumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "in_progress_enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
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
  SELECT b.in_progress_enabled AND o.in_progress_enabled, b.in_progress_resumed_at
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
DROP TRIGGER IF EXISTS card_track_in_progress ON card;--> statement-breakpoint
CREATE TRIGGER card_track_in_progress
BEFORE INSERT OR UPDATE OF board_id, list_id, completed_at, archived_at ON card
FOR EACH ROW EXECUTE FUNCTION card_track_in_progress();--> statement-breakpoint
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
    WHERE c.board_id = b.id AND b.in_progress_enabled AND o.in_progress_enabled
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
DROP TRIGGER IF EXISTS list_backfill_in_progress ON list;--> statement-breakpoint
CREATE TRIGGER list_backfill_in_progress
AFTER UPDATE OF in_progress ON list
FOR EACH ROW EXECUTE FUNCTION list_backfill_in_progress();--> statement-breakpoint
-- Settings changes bank existing stints, retain history, and start fresh on resume.
-- Updating board rows on organisation changes also serializes new cards with the card trigger.
CREATE FUNCTION board_reconcile_in_progress() RETURNS trigger AS $$
DECLARE enabled boolean; zone text;
BEGIN
  SELECT o.in_progress_enabled AND NEW.in_progress_enabled, w.time_zone INTO enabled, zone
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
CREATE FUNCTION board_stamp_in_progress_resume() RETURNS trigger AS $$
BEGIN
  IF NEW.in_progress_enabled IS DISTINCT FROM OLD.in_progress_enabled THEN
    NEW.in_progress_resumed_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER board_stamp_in_progress_resume BEFORE UPDATE OF in_progress_enabled ON board
FOR EACH ROW EXECUTE FUNCTION board_stamp_in_progress_resume();--> statement-breakpoint
CREATE TRIGGER board_reconcile_in_progress AFTER UPDATE OF in_progress_enabled, in_progress_resumed_at ON board
FOR EACH ROW EXECUTE FUNCTION board_reconcile_in_progress();--> statement-breakpoint
CREATE FUNCTION client_reconcile_in_progress() RETURNS trigger AS $$
BEGIN
  IF NEW.in_progress_enabled IS DISTINCT FROM OLD.in_progress_enabled THEN
    UPDATE board SET in_progress_resumed_at = now()
    WHERE workspace_id IN (SELECT id FROM workspace WHERE client_id = NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER client_reconcile_in_progress AFTER UPDATE OF in_progress_enabled ON client
FOR EACH ROW EXECUTE FUNCTION client_reconcile_in_progress();
