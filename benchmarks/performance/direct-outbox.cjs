// DATABASE_URL=postgres://.../kanera_test_... node benchmarks/performance/direct-outbox.cjs
// Uses one connection-local temporary table only. No application rows or permanent indexes change.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const req = createRequire(path.resolve(__dirname, '../../apps/api/package.json'));
const { Client } = req('pg');
const url = process.env.DATABASE_URL;
if (!url || !/^kanera_test(?:_[a-z0-9_]+)?$/.test(new URL(url).pathname.slice(1))) throw new Error('DATABASE_URL must name an isolated kanera_test database');
const client = new Client({ connectionString: url });
const query = `select id from perf_direct_outbox where realtime_dispatched = false and (processing_lease_expires_at is null or processing_lease_expires_at <= now()) order by created_at, id limit 50 for update skip locked`;
(async () => {
  await client.connect();
  try {
    await client.query('create temporary table perf_direct_outbox (like direct_realtime_outbox including defaults)');
    await client.query(`insert into perf_direct_outbox(scope,client_id,event_type,payload,created_at) select 'client',gen_random_uuid(),'client:updated',jsonb_build_object('name',repeat('a',100)),now()-i*interval '1 millisecond' from generate_series(1,100000) s(i)`);
    await client.query('create index perf_old_order on perf_direct_outbox(processing_lease_expires_at,created_at) where realtime_dispatched = false');
    await client.query('analyze perf_direct_outbox');
    const before = [];
    for (let i = 0; i < 3; i++) before.push((await client.query('explain (analyze,buffers,format json) ' + query)).rows[0]['QUERY PLAN'][0]);
    await client.query('drop index perf_old_order');
    await client.query('create index perf_new_order on perf_direct_outbox(created_at,id) where realtime_dispatched = false');
    await client.query('analyze perf_direct_outbox');
    const after = [];
    for (let i = 0; i < 3; i++) after.push((await client.query('explain (analyze,buffers,format json) ' + query)).rows[0]['QUERY PLAN'][0]);
    const result = { fixtureRows: 100000, claimLimit: 50, query, before, after };
    if (process.env.KANERA_PERF_OUTPUT) fs.writeFileSync(process.env.KANERA_PERF_OUTPUT, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ fixtureRows: 100000, beforeMs: before.map(x => x['Execution Time']), afterMs: after.map(x => x['Execution Time']) }, null, 2));
  } finally {
    await client.end();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
