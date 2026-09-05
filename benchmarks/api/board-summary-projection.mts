/** pnpm with:local-env pnpm --filter @kanera/api exec tsx ../../benchmarks/api/board-summary-projection.mts */
import assert from 'node:assert/strict';
import { pool } from '../../apps/api/src/db.js';
import { loadBoardCardSummaries } from '../../apps/api/src/lib/card-summary.js';

const database = new URL(process.env.DATABASE_URL ?? '');
if (!['localhost', '127.0.0.1', '::1'].includes(database.hostname)) throw new Error('Benchmark requires a local database');
const options = { boardId: '70000000-0000-4000-8000-000000000200', includeCompleted: true, includeArchived: false, completedCardsActiveDays: 7 };
try {
  const fields = await pool.query<{ id: string }>(`select id from custom_field where workspace_id = '70000000-0000-4000-8000-000000000100' and show_on_card = true and archived_at is null`);
  const ids = new Set(fields.rows.map(field => field.id));
  const all = await loadBoardCardSummaries(options);
  const shown = await loadBoardCardSummaries({ ...options, shownCustomFieldsOnly: true });
  assert.equal(all.length, 1000, 'Seed the standard web benchmark fixture first');
  assert.deepEqual(shown, all.map(row => ({ ...row, customFieldValues: row.customFieldValues.filter(value => ids.has(value.fieldId)) })));
  const times: number[][] = [[], []];
  for (let round = 0; round < 11; round++) {
    for (const variant of round % 2 ? [1, 0] : [0, 1]) {
      const start = performance.now();
      await loadBoardCardSummaries({ ...options, shownCustomFieldsOnly: Boolean(variant) });
      times[variant].push(performance.now() - start);
    }
  }
  console.log(JSON.stringify({ cardCount: all.length, equalVisibleOutputs: true, variants: [all, shown].map((rows, index) => ({
    name: index ? 'shown fields in SQL' : 'all fields (previous query)',
    customFieldValues: rows.reduce((sum, row) => sum + row.customFieldValues.length, 0),
    serializedRowBytes: Buffer.byteLength(JSON.stringify(rows)),
    medianMs: [...times[index]].sort((a,b) => a-b)[5],
    roundsMs: times[index],
  })) }, null, 2));
} finally { await pool.end(); }
