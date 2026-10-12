#!/usr/bin/env node
/** Constant-only, read-only PostgreSQL checks for benchmark SQL transport alternatives. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { SUMMARY_QUERY_VARIANTS, transformSummaryQuery, transformSummaryResult } from './board-hydration-query.mjs';
const root = resolve(import.meta.dirname, '../..');
const require = createRequire(`${root}/apps/api/package.json`);
const pg = require(`${root}/apps/api/node_modules/pg`);
const connectionString = process.env.HYDRATION_VERIFY_DATABASE_URL ?? 'postgres://kanera:kanera@127.0.0.1:5433/postgres';
assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(connectionString).hostname), 'Local database only');
const client = new pg.Client({ connectionString, options: '-c default_transaction_read_only=on' });
const out = resolve(process.env.HYDRATION_OUTPUT ?? `${root}/benchmarks/api/results/event-loop-20261012`, 'query-contracts.json');
// Only static projection fragments are executed below; interpolation placeholders in this
// source template stay inert. This keeps standalone verification independent of saved profiles.
const source = readFileSync(`${root}/apps/api/src/lib/card-summary.ts`, 'utf8');
const start = source.indexOf('    with filtered_cards as materialized');
assert.notEqual(start, -1, 'Could not find current card-summary SQL template');
const end = source.indexOf('\n  `);', start);
assert.notEqual(end, -1, 'Could not find end of current card-summary SQL template');
const original = source.slice(start, end).replace('${compactCustomFields ? sql`ABSENT ON NULL` : sql`NULL ON NULL`}', 'ABSENT ON NULL');
const checked = [];
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checked.push(name); };
const base = {
  card_id: '00000000-0000-4000-8000-000000000001',
  field_id: '00000000-0000-4000-8000-000000000010',
  value_text: null, value_number: null, value_checkbox: null, value_date: null, value_url: null,
  value_option_ids: null, value_user_ids: null, updated_at: '2026-10-12T12:34:56.123456+05:30',
};
const fixtures = [
  base,
  { ...base, field_id: '00000000-0000-4000-8000-000000000011', value_text: '', value_number: '0.0000000000', value_checkbox: false, value_option_ids: [], value_user_ids: [] },
  { ...base, field_id: '00000000-0000-4000-8000-000000000012', value_text: 'quote " / slash \\ newline\n日本語🙂', value_number: '12345678901234567890.123456789', value_checkbox: true, value_date: '2026-10-12', value_url: 'https://example.test/?a="&b=1', value_option_ids: ['00000000-0000-4000-8000-000000000020', null], value_user_ids: [null, '00000000-0000-4000-8000-000000000030'] },
];
const records = `json_to_recordset($1::json) as cfv(card_id uuid, field_id uuid, value_text text, value_number numeric, value_checkbox boolean, value_date date, value_url text, value_option_ids uuid[], value_user_ids uuid[], updated_at timestamptz)`;
const expression = (sql) => {
  const prefix = 'json_agg(\n          ';
  return sql.slice(sql.indexOf(prefix) + prefix.length, sql.indexOf('\n          order by cfv.field_id\n        ) as custom_field_values'));
};
await client.connect();
try {
  const version = (await client.query('select version()')).rows[0].version;
  const full = (await client.query(`select ${expression(transformSummaryQuery(original, 'p1'))} as value from ${records} order by cfv.field_id`, [JSON.stringify(fixtures)])).rows.map((row) => row.value);
  const compact = full.map((value) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null)));
  for (const variant of ['baseline', 'sql-compact', 'sql-absent', 'sql-combined', 'sql-absent-combined', 'sql-absent-json-rows']) {
    const transformed = transformSummaryQuery(original, variant);
    const rows = (await client.query(`select ${expression(transformed)} as value from ${records} order by cfv.field_id`, [JSON.stringify(fixtures)])).rows.map((row) => row.value);
    check(`${variant}: absent nulls; preserve false/empty/zero/decimal/Unicode/dates/array-null-elements`, rows, compact);
  }
  const identifiers = [
    { id: '00000000-0000-4000-8000-000000000023', assigned_at: '2026-10-12T00:00:00Z' },
    { id: '00000000-0000-4000-8000-000000000021', assigned_at: '2026-10-11T00:00:00Z' },
    { id: '00000000-0000-4000-8000-000000000022', assigned_at: '2026-10-12T00:00:00Z' },
  ];
  // Exercise the actual source expressions, including both empty-result defaults. The tied
  // timestamps deliberately make losing the UUID tiebreaker observable without clock races.
  for (const [alias, table, column] of [['label_ids', 'cla', 'label_id'], ['assignee_ids', 'ca', 'user_id']]) {
    for (const variant of ['baseline', 'pg-arrays']) {
      const query = transformSummaryQuery(original, variant);
      const aggregate = query.match(new RegExp(`((?:json|array)_agg\\([^\\n]+\\)) as ${alias}`))?.[1];
      const fallback = query.match(new RegExp(`coalesce\\(${alias}\\.${alias}, ([^\\n]+)\\) as`))?.[1];
      assert.ok(aggregate && fallback, `Missing ${alias} projection`);
      for (const values of [identifiers, identifiers.slice(0, 1), []]) {
        const records = values.map(({ id, assigned_at }) => ({ [column]: id, assigned_at }));
        const row = (await client.query(`select coalesce(${aggregate}, ${fallback}) as ids from json_to_recordset($1::json) as ${table}(${column} uuid, assigned_at timestamptz)`, [JSON.stringify(records)])).rows[0];
        const expected = [...values].sort((a, b) => a.assigned_at.localeCompare(b.assigned_at) || a.id.localeCompare(b.id)).map(value => value.id);
        check(`${variant} ${alias}: ${values.length} IDs preserve assigned_at/UUID ordering and empty arrays`, row.ids, expected);
      }
    }
  }
  const types = { getTypeParser(oid, format) { return [1082, 1114, 1184].includes(oid) ? (value) => value : pg.types.getTypeParser(oid, format); } };
  const projection = `'2026-10-12T12:34:56.123456+05:30'::timestamptz as "createdAt", null::timestamptz as "completedAt", '9999999999.9999999999'::numeric(20,10) as position, '2026-10-12'::date as "dueDateLocalDate", false as "hasDescription", 0::integer as "commentCount", '{"valueNumber":"12345678901234567890.123456789","valueCheckbox":false}'::json as "customFieldValue"`;
  const expected = (await client.query({ text: `select ${projection}`, types })).rows;
  const asText = projection.replace('::timestamptz as', '::timestamptz::text as').replace('null::timestamptz as', 'null::timestamptz::text as').replace('::numeric(20,10) as', '::numeric(20,10)::text as');
  const result = await client.query({ text: `select json_agg(row_to_json(r)) as "__boardCardRows" from (select ${asText}) r`, types });
  check('json rows: exact raw Drizzle timestamp/date/decimal/null/boolean/integer/nested JSON types', transformSummaryResult(result, 'json-rows').rows, expected);
  check('json rows: empty envelope expands to empty rows', transformSummaryResult({ rows: [{ __boardCardRows: [] }] }, 'json-rows').rows, []);
  for (const variant of SUMMARY_QUERY_VARIANTS) assert.ok(transformSummaryQuery(original, variant).includes('filtered_cards'));
  checked.push(`All ${SUMMARY_QUERY_VARIANTS.length} variants accept the checked-in summary SQL template structure`);
  const report = { capturedAt: new Date().toISOString(), node: process.version, postgres: version, method: 'Constant-only SELECTs on a local database using a read-only connection; no application data read or written.', nativeAbsentOnNullRequiresPostgres: '16+', reference: 'https://www.postgresql.org/docs/16/functions-json.html', allPassed: true, checks: checked };
  mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output: out, allPassed: true, checks: checked.length }));
} finally { await client.end(); }
