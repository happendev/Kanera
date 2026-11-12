-- Run only in kanera-postgres after pnpm perf:web:seed. The marked board is test-owned.
-- 100 independent chains of 10; all 1,000 cards have planned starts and due dates.
BEGIN;
DO $$ BEGIN
  IF (SELECT count(*) FROM card WHERE board_id = '70000000-0000-4000-8000-000000000200') <> 1000 THEN
    RAISE EXCEPTION 'Expected the default 1000-card local performance fixture';
  END IF;
END $$;
WITH ordered AS (
  SELECT id, workspace_id, row_number() OVER (ORDER BY id) AS n,
    lead(id) OVER (ORDER BY id) AS next_id
  FROM card WHERE board_id = '70000000-0000-4000-8000-000000000200'
)
INSERT INTO card_relation (workspace_id, source_card_id, target_card_id, kind)
SELECT workspace_id, id, next_id, 'blocks' FROM ordered
WHERE n % 10 <> 0 AND next_id IS NOT NULL ON CONFLICT DO NOTHING;
UPDATE card SET start_date_local_date = due_date_local_date - 2
WHERE board_id = '70000000-0000-4000-8000-000000000200';
COMMIT;
