#!/usr/bin/env node
// Read-only database cost check: native JSON shifts work into PostgreSQL, so measure that too.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { SUMMARY_QUERY_VARIANTS, transformSummaryQuery } from './board-hydration-query.mjs';
const root = resolve(import.meta.dirname, '../..');
const require = createRequire(`${root}/apps/api/package.json`), pg = require(`${root}/apps/api/node_modules/pg`);
const database = new URL(process.env.DATABASE_URL);
assert.equal(database.hostname, '127.0.0.1');
assert.match(database.pathname, /^\/kanera_hydration_\d+$/, 'Use only the runner-owned temporary fixture');
const out = process.env.HYDRATION_OUTPUT;
assert.ok(out, 'HYDRATION_OUTPUT is required');
const query = JSON.parse(readFileSync(`${out}/query.json`, 'utf8'));
assert.ok(query?.text.includes('with filtered_cards as materialized'));
assert.ok(Array.isArray(query.values) && query.values.length > 0, 'Capture query parameters as well as SQL before collecting plans');
const client = new pg.Client({ connectionString: database.toString() });
await client.connect();
const plans = [];
try {
  for (let round = 0; round < 3; round++) {
    for (const memory of round % 2 ? [16, 4] : [4, 16]) {
      for (const variant of round % 2 ? [...SUMMARY_QUERY_VARIANTS].reverse() : SUMMARY_QUERY_VARIANTS) {
        await client.query('BEGIN READ ONLY');
        try {
          await client.query(`SET LOCAL work_mem = '${memory}MB'`);
          const result = await client.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + transformSummaryQuery(query.text, variant), query.values);
          plans.push({ variant, memory, round, plan: result.rows[0]['QUERY PLAN'][0] });
        } finally { await client.query('ROLLBACK'); }
      }
    }
  }
  writeFileSync(`${out}/plans.json`, JSON.stringify(plans, null, 2));
  console.table(plans.map(({variant, memory, round, plan}) => ({ variant, memory, round, executionMs: plan['Execution Time'], planningMs: plan['Planning Time'], tempBlocks: plan.Plan['Temp Written Blocks'] })));
} finally { await client.end(); }
